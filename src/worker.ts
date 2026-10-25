import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { EffectRunner } from "./effects.js";
import { verifyLinearSignature, withLinearSession } from "./linear.js";
import manifest, { LINEAR_WEBHOOK_KEY, SWEEP_JOB_KEY, WATCHED_EVENTS } from "./manifest.js";
import { handleLinearWebhook, handleTaskEvents, runSweep, type LinearWebhookPayload, type SyncContext } from "./sync.js";

const ORIGIN_KIND = `plugin:${manifest.id}` as const;

/** Paperclip events arrive in bursts (an agent run comments, updates, relates); one pass per burst. */
export const EVENT_DEBOUNCE_MS = 5_000;

let context: PluginContext | null = null;

// One pass at a time per company: events, webhooks and the sweep all read and
// write the same plugin state, and two concurrent passes could post twice.
const chains = new Map<string, Promise<void>>();
function serialize<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(companyId) ?? Promise.resolve();
  const run = previous.then(work, work);
  chains.set(companyId, run.then(() => undefined, () => undefined));
  return run;
}

/** Run `work` with config, a Linear session and an effect runner; `null` when the company has the sync off. */
async function withSync<T>(ctx: PluginContext, companyId: string, work: (sync: SyncContext) => Promise<T>): Promise<T | null> {
  const parsed = parseConfig(await ctx.config.get(companyId));
  if ("skip" in parsed) {
    ctx.logger.debug("Linear sync skipped", { companyId, reason: parsed.skip });
    return null;
  }
  const config = parsed.config;
  const fetch = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  const [clientId, clientSecret] = await Promise.all([
    ctx.secrets.resolve(config.linearClientId, { companyId, configPath: "linearClientId" }),
    ctx.secrets.resolve(config.linearClientSecret, { companyId, configPath: "linearClientSecret" }),
  ]);
  return withLinearSession(fetch, { clientId, clientSecret }, async (linear) => {
    const nowMs = Date.now();
    const runner = new EffectRunner(ctx, companyId, config.mode, linear, nowMs);
    try {
      return await work({ ctx, companyId, config, linear, self: await linear.self(), runner, nowMs, originKind: ORIGIN_KIND });
    } finally {
      await runner.flush();
    }
  });
}

// Work queued by Paperclip events and Linear webhooks, per company. Webhooks
// only verify and queue: Linear gives up on a delivery after 5 seconds and may
// disable a webhook that keeps timing out, and a pass can wait behind a sweep.
const pendingTasks = new Map<string, Set<string>>();
const pendingLinear = new Map<string, Map<string, LinearWebhookPayload>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function schedule(companyId: string): void {
  if (!timers.has(companyId)) timers.set(companyId, setTimeout(() => void processQueued(companyId), EVENT_DEBOUNCE_MS));
}

async function processQueued(companyId: string): Promise<void> {
  const timer = timers.get(companyId);
  if (timer) clearTimeout(timer);
  timers.delete(companyId);
  const taskIds = [...(pendingTasks.get(companyId) ?? [])];
  const webhooks = [...(pendingLinear.get(companyId)?.values() ?? [])];
  pendingTasks.delete(companyId);
  pendingLinear.delete(companyId);
  if ((taskIds.length === 0 && webhooks.length === 0) || !context) return;
  const ctx = context;
  try {
    await serialize(companyId, () =>
      withSync(ctx, companyId, async (sync) => {
        if (taskIds.length > 0) await handleTaskEvents(sync, taskIds);
        for (const payload of webhooks) await handleLinearWebhook(sync, payload);
      }),
    );
  } catch (error) {
    // The sweep reconciles the same issues within 5 minutes.
    ctx.logger.warn("Linear sync queued pass failed; the sweep will retry", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Run every queued pass now instead of waiting for the debounce (tests). */
export async function drainEvents(): Promise<void> {
  const companies = new Set([...pendingTasks.keys(), ...pendingLinear.keys(), ...timers.keys()]);
  await Promise.all([...companies].map((companyId) => processQueued(companyId)));
}

function header(headers: Record<string, string | string[]>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;

    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        try {
          const report = await serialize(company.id, () => withSync(ctx, company.id, runSweep));
          if (report) ctx.logger.info("Linear sync sweep finished", { companyId: company.id, ...report });
        } catch (error) {
          // Never log secrets: only the message of our own errors reaches here.
          ctx.logger.error("Linear sync sweep failed", { companyId: company.id, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
    });

    for (const eventType of WATCHED_EVENTS) {
      ctx.events.on(eventType, async (event) => {
        // The plugin's own writes come back as events; reacting to them would loop.
        if (event.actorType === "plugin" || event.entityType !== "issue" || !event.entityId) return;
        const queued = pendingTasks.get(event.companyId) ?? new Set<string>();
        queued.add(event.entityId);
        pendingTasks.set(event.companyId, queued);
        schedule(event.companyId);
      });
    }
  },

  async onWebhook(input) {
    const ctx = context;
    if (!ctx || input.endpointKey !== LINEAR_WEBHOOK_KEY) return;
    const payload = (input.parsedBody ?? JSON.parse(input.rawBody)) as LinearWebhookPayload & { webhookTimestamp?: unknown };
    const signature = header(input.headers, "linear-signature");
    // Plugin installation is instance-wide: the company is the one whose webhook secret signed the body.
    for (const company of await ctx.companies.list()) {
      const parsed = parseConfig(await ctx.config.get(company.id));
      if ("skip" in parsed || !parsed.config.linearWebhookSecret) continue;
      const secret = await ctx.secrets.resolve(parsed.config.linearWebhookSecret, { companyId: company.id, configPath: "linearWebhookSecret" });
      if (!verifyLinearSignature({ rawBody: input.rawBody, signature, secret, webhookTimestamp: payload.webhookTimestamp, nowMs: Date.now() })) continue;
      const issueId = payload.type === "Comment" ? payload.data?.issueId : payload.data?.id;
      if (!issueId) return;
      const queued = pendingLinear.get(company.id) ?? new Map<string, LinearWebhookPayload>();
      // Issue deliveries may take new work in; keep that kind if both arrive for one issue.
      if (queued.get(issueId)?.type !== "Issue") queued.set(issueId, payload);
      pendingLinear.set(company.id, queued);
      schedule(company.id);
      return;
    }
    ctx.logger.warn("Linear webhook rejected: no enabled company's secret matches the signature", { requestId: input.requestId });
  },

  async onHealth() {
    return { status: "ok", message: "Linear sync worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
