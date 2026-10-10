import { definePlugin, runWorker, type Issue, type PluginContext, type PluginJobContext, type ScopeKey } from "@paperclipai/plugin-sdk";
import { parseConfig, type GateConfig } from "./config.js";
import { blockedDelta, decide, pendingMentions, type BlockedTask, type LastFire, type PendingWork } from "./gate.js";
import { withLinearSession } from "./linear.js";
import { CHECK_JOB_KEY } from "./manifest.js";

interface GateState {
  seenBlocked: string[] | null;
  lastFire: LastFire | null;
}

const stateKey = (companyId: string): ScopeKey => ({
  scopeKind: "company",
  scopeId: companyId,
  namespace: "linear-sync-gate",
  stateKey: "gate",
});

const PAGE_SIZE = 100;

async function readState(ctx: PluginContext, companyId: string): Promise<GateState> {
  const stored = (await ctx.state.get(stateKey(companyId))) as Partial<GateState> | null;
  return { seenBlocked: stored?.seenBlocked ?? null, lastFire: stored?.lastFire ?? null };
}

/** Blocked tasks of the agent, each with its own labels plus its direct blockers' labels. */
async function loadBlockedTasks(ctx: PluginContext, companyId: string, agentId: string): Promise<BlockedTask[]> {
  const blocked: Issue[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await ctx.issues.list({ companyId, assigneeAgentId: agentId, status: "blocked", limit: PAGE_SIZE, offset });
    blocked.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const cache = new Map<string, Issue | null>();
  const getIssue = async (id: string) => {
    if (!cache.has(id)) cache.set(id, await ctx.issues.get(id, companyId));
    return cache.get(id) ?? null;
  };
  const tasks: BlockedTask[] = [];
  for (const summary of blocked) {
    const issue = (await getIssue(summary.id)) ?? summary;
    const blockers = await Promise.all((issue.blockedBy ?? []).map((blocker) => getIssue(blocker.id)));
    const labelNames = [issue, ...blockers].flatMap((item) => (item?.labels ?? []).map((label) => label.name));
    tasks.push({ id: issue.id, identifier: issue.identifier, labelNames });
  }
  return tasks;
}

type Delivery = { delivered: true; outcome: string } | { delivered: false; outcome: string };

async function fireWebhook(
  ctx: PluginContext,
  config: GateConfig,
  companyId: string,
  idempotencyKey: string,
  work: PendingWork,
  items: string[],
): Promise<Delivery> {
  const secret = await ctx.secrets.resolve(config.webhookSecret, { companyId, configPath: "webhookSecret" });
  const response = await ctx.http.fetch(config.webhookUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      event: "linear-sync-gate.pending",
      counts: { mentions: work.mentions.length, intake: work.intake.length, newlyBlocked: work.newlyBlocked.length },
      items,
    }),
  });
  const body = (await response.json().catch(() => null)) as { status?: string; test?: boolean; run?: { status?: string } } | null;
  if (!response.ok) return { delivered: false, outcome: `http-${response.status}` };
  // Setup mode (`setupPending: true`) answers `test_received` and never starts a run.
  if (body?.test === true || body?.status === "test_received") return { delivered: true, outcome: "test_received" };
  const runStatus = body?.run?.status ?? body?.status ?? "accepted";
  // A coalesced/skipped delivery was folded into a run that may predate this
  // work: keep state untouched so the next check fires again.
  if (runStatus === "coalesced" || runStatus === "skipped") return { delivered: false, outcome: runStatus };
  return { delivered: true, outcome: runStatus };
}

export async function checkCompany(ctx: PluginContext, companyId: string, job: PluginJobContext, nowMs = Date.now()): Promise<void> {
  const parsed = parseConfig(await ctx.config.get(companyId));
  if ("skip" in parsed) {
    ctx.logger.debug("Linear sync gate skipped", { companyId, reason: parsed.skip });
    return;
  }
  const config = parsed.config;
  const fetch = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  const [clientId, clientSecret] = await Promise.all([
    ctx.secrets.resolve(config.linearClientId, { companyId, configPath: "linearClientId" }),
    ctx.secrets.resolve(config.linearClientSecret, { companyId, configPath: "linearClientSecret" }),
  ]);

  const linear = await withLinearSession(fetch, { clientId, clientSecret }, async (session) => {
    const self = await session.self();
    const issues = await session.issuesWithComments(config.readyLabel);
    const truncated = issues.filter((issue) => issue.comments.pageInfo?.hasNextPage);
    if (truncated.length > 0) {
      ctx.logger.warn("Some issues have more than 100 comments; the oldest were not checked", {
        issues: truncated.map((issue) => issue.identifier),
      });
    }
    return {
      mentions: pendingMentions(issues, self),
      intake: await session.todoIdentifiers(config.todoStateName, config.readyLabel),
    };
  });

  const state = await readState(ctx, companyId);
  const delta = blockedDelta(await loadBlockedTasks(ctx, companyId, config.agentId), state.seenBlocked, config.awaitingMergeLabel);
  const work: PendingWork = { mentions: linear.mentions, intake: linear.intake, newlyBlocked: delta.newlyBlocked };
  const decision = decide(work, state.lastFire, nowMs, config.refireMinutes * 60_000);
  const counts = { mentions: work.mentions.length, intake: work.intake.length, newlyBlocked: work.newlyBlocked.length };

  if (!decision.fire) {
    await ctx.state.set(stateKey(companyId), { seenBlocked: delta.nextSeen, lastFire: state.lastFire } satisfies GateState);
    ctx.logger.info("Linear sync gate: nothing to fire", { companyId, reason: decision.reason, ...counts });
    return;
  }

  const delivery = await fireWebhook(ctx, config, companyId, `${decision.key}-${job.scheduledAt}`, work, decision.items);
  if (delivery.delivered) {
    await ctx.state.set(stateKey(companyId), {
      seenBlocked: delta.nextSeen,
      lastFire: { key: decision.key, atMs: nowMs },
    } satisfies GateState);
    ctx.logger.info("Linear sync gate fired the routine", { companyId, outcome: delivery.outcome, items: decision.items, ...counts });
  } else {
    ctx.logger.warn("Linear sync gate delivery not accepted; will retry next check", {
      companyId,
      outcome: delivery.outcome,
      items: decision.items,
    });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register(CHECK_JOB_KEY, async (job) => {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        try {
          await checkCompany(ctx, company.id, job);
        } catch (error) {
          // Never log secrets: only the message of our own errors reaches here.
          ctx.logger.error("Linear sync gate check failed", {
            companyId: company.id,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "Linear sync gate worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
