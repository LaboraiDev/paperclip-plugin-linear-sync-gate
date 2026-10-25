// Every write the sync makes goes through here. In `observe` mode nothing is
// written: each effect is logged once and kept in a bounded list for review.
// In `act` mode each effect runs once per key, ever (keys carry the episode).
import type { Issue, PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { SyncMode } from "./config.js";
import { deterministicUuid, type LinearSession } from "./linear.js";

export type Effect =
  | { kind: "linear.comment"; key: string; linearIssueId: string; body: string; parentId?: string | null }
  /** Desired-state change: emitted only while Linear differs, so it is not deduplicated in `act`. */
  | { kind: "linear.labels"; key: string; linearIssueId: string; add: string[]; remove: string[]; repeatable: true }
  | { kind: "linear.state"; key: string; linearIssueId: string; teamId: string; stateName: string; repeatable?: true }
  | { kind: "paperclip.comment"; key: string; issueId: string; body: string; actorUserId?: string | null }
  | { kind: "paperclip.status"; key: string; issueId: string; status: "todo" }
  | { kind: "paperclip.wakeup"; key: string; issueId: string; reason: string }
  | { kind: "paperclip.blockers"; key: string; issueId: string; add: string[] }
  | {
      kind: "paperclip.createIssue";
      key: string;
      input: { title: string; description: string; assigneeAgentId: string; projectId?: string; originKind: `plugin:${string}`; originId: string };
    };

export type EffectOutcome = "applied" | "observed" | "duplicate" | "failed";

export interface EffectResult {
  key: string;
  kind: Effect["kind"];
  outcome: EffectOutcome;
  error?: string;
  createdIssue?: Issue;
}

export const NAMESPACE = "linear-sync";
export const stateKey = (companyId: string, key: string): ScopeKey => ({ scopeKind: "company", scopeId: companyId, namespace: NAMESPACE, stateKey: key });

export async function readState<T>(ctx: PluginContext, companyId: string, key: string, fallback: T): Promise<T> {
  const stored = await ctx.state.get(stateKey(companyId, key));
  return (stored ?? fallback) as T;
}

export async function writeState(ctx: PluginContext, companyId: string, key: string, value: unknown): Promise<void> {
  await ctx.state.set(stateKey(companyId, key), value);
}

const KEEP_KEYS_MS = 30 * 24 * 60 * 60_000;
const OBSERVED_LOG_SIZE = 300;

export interface ObservedEntry {
  at: string;
  kind: Effect["kind"];
  key: string;
  summary: string;
}

function summarize(effect: Effect): string {
  switch (effect.kind) {
    case "linear.comment":
      return `comment on Linear ${effect.linearIssueId}: ${effect.body.slice(0, 160)}`;
    case "linear.labels":
      return `labels on Linear ${effect.linearIssueId}: +[${effect.add.join(", ")}] -[${effect.remove.join(", ")}]`;
    case "linear.state":
      return `state of Linear ${effect.linearIssueId} → ${effect.stateName}`;
    case "paperclip.comment":
      return `comment on task ${effect.issueId}${effect.actorUserId ? ` as user ${effect.actorUserId}` : ""}: ${effect.body.slice(0, 160)}`;
    case "paperclip.status":
      return `status of task ${effect.issueId} → ${effect.status}`;
    case "paperclip.wakeup":
      return `wake task ${effect.issueId}: ${effect.reason}`;
    case "paperclip.blockers":
      return `task ${effect.issueId} blocked by ${effect.add.join(", ")}`;
    case "paperclip.createIssue":
      return `create task «${effect.input.title}» for ${effect.input.originId}`;
  }
}

export class EffectRunner {
  readonly results: EffectResult[] = [];
  private seen: Record<string, number> | null = null;
  private observed: ObservedEntry[] | null = null;

  constructor(
    private readonly ctx: PluginContext,
    private readonly companyId: string,
    private readonly mode: SyncMode,
    private readonly linear: LinearSession,
    private readonly nowMs: number,
  ) {}

  private async loadSeen(): Promise<Record<string, number>> {
    this.seen ??= await readState<Record<string, number>>(this.ctx, this.companyId, `effects:${this.mode}`, {});
    return this.seen;
  }

  async run(effect: Effect): Promise<EffectResult> {
    const seen = await this.loadSeen();
    const repeatable = "repeatable" in effect && effect.repeatable === true;
    let result: EffectResult;
    if (seen[effect.key] !== undefined && (this.mode === "observe" || !repeatable)) {
      result = { key: effect.key, kind: effect.kind, outcome: "duplicate" };
    } else if (this.mode === "observe") {
      this.observed ??= await readState<ObservedEntry[]>(this.ctx, this.companyId, "observed", []);
      this.observed.push({ at: new Date(this.nowMs).toISOString(), kind: effect.kind, key: effect.key, summary: summarize(effect) });
      seen[effect.key] = this.nowMs;
      this.ctx.logger.info("Linear sync (observe): would apply", { companyId: this.companyId, kind: effect.kind, key: effect.key, summary: summarize(effect) });
      result = { key: effect.key, kind: effect.kind, outcome: "observed" };
    } else {
      try {
        const createdIssue = await this.apply(effect);
        seen[effect.key] = this.nowMs;
        result = { key: effect.key, kind: effect.kind, outcome: "applied", ...(createdIssue ? { createdIssue } : {}) };
        this.ctx.logger.info("Linear sync applied", { companyId: this.companyId, kind: effect.kind, key: effect.key });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { key: effect.key, kind: effect.kind, outcome: "failed", error: message };
        this.ctx.logger.warn("Linear sync effect failed; will retry on a later pass", { companyId: this.companyId, kind: effect.kind, key: effect.key, error: message });
      }
    }
    this.results.push(result);
    return result;
  }

  private async apply(effect: Effect): Promise<Issue | undefined> {
    const { ctx, companyId, linear } = this;
    switch (effect.kind) {
      case "linear.comment":
        await linear.createComment({ id: deterministicUuid(effect.key), issueId: effect.linearIssueId, body: effect.body, parentId: effect.parentId });
        return;
      case "linear.labels": {
        const resolve = async (names: string[]) => {
          const ids: string[] = [];
          for (const name of names) {
            const id = await linear.labelId(name);
            if (!id) throw new Error(`Linear has no label named '${name}'`);
            ids.push(id);
          }
          return ids;
        };
        await linear.updateLabels(effect.linearIssueId, { add: await resolve(effect.add), remove: await resolve(effect.remove) });
        return;
      }
      case "linear.state":
        await linear.setState(effect.linearIssueId, effect.teamId, effect.stateName);
        return;
      case "paperclip.comment":
        await ctx.issues.createComment(effect.issueId, effect.body, companyId, effect.actorUserId ? { actorUserId: effect.actorUserId } : undefined);
        return;
      case "paperclip.status":
        await ctx.issues.update(effect.issueId, { status: effect.status }, companyId);
        return;
      case "paperclip.wakeup":
        await ctx.issues.requestWakeup(effect.issueId, companyId, { reason: effect.reason, idempotencyKey: effect.key });
        return;
      case "paperclip.blockers":
        await ctx.issues.relations.addBlockers(effect.issueId, effect.add, companyId);
        return;
      case "paperclip.createIssue":
        return ctx.issues.create({ companyId, ...effect.input });
    }
  }

  /** Persist which keys ran, dropping keys older than 30 days, and the bounded observe log. */
  async flush(): Promise<void> {
    if (this.seen) {
      const cutoff = this.nowMs - KEEP_KEYS_MS;
      const kept = Object.fromEntries(Object.entries(this.seen).filter(([, at]) => at >= cutoff));
      await writeState(this.ctx, this.companyId, `effects:${this.mode}`, kept);
    }
    if (this.observed) {
      await writeState(this.ctx, this.companyId, "observed", this.observed.slice(-OBSERVED_LOG_SIZE));
    }
  }

  counts(): Record<EffectOutcome, number> {
    const counts: Record<EffectOutcome, number> = { applied: 0, observed: 0, duplicate: 0, failed: 0 };
    for (const result of this.results) counts[result.outcome] += 1;
    return counts;
  }
}
