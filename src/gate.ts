// Pure decision logic. No I/O here: everything the job reads from Linear or
// Paperclip is passed in, so every rule below is unit-tested directly.
import { createHash } from "node:crypto";

export interface LinearComment {
  id: string;
  body: string | null;
  createdAt: string;
  user: { id: string; name?: string } | null;
}

export interface LinearIssueWithComments {
  identifier: string;
  comments: { nodes: LinearComment[]; pageInfo?: { hasNextPage?: boolean } };
}

export interface LinearSelf {
  id: string;
  name: string;
  url: string;
}

export interface PendingMention {
  identifier: string;
  commentId: string;
}

/**
 * Same rule as `linear-app-actor.sh pending-mentions` (skill revision in
 * production on 2026-10-10):
 * - comments sorted by createdAt;
 * - a mention is a comment NOT written by the app whose body matches
 *   `@<app name>` (case-insensitive regex) or contains the app's profile URL;
 * - pending when the last mention is newer than the app's last comment
 *   (or the app never commented).
 */
export function pendingMentions(issues: LinearIssueWithComments[], self: LinearSelf): PendingMention[] {
  const mentionPattern = new RegExp(`@${self.name}`, "i");
  const pending: PendingMention[] = [];
  for (const issue of issues) {
    const comments = [...issue.comments.nodes].sort((a, b) => compareStrings(a.createdAt, b.createdAt));
    const fromSelf = (comment: LinearComment) => (comment.user?.id ?? null) === self.id;
    const lastSelf = comments.filter(fromSelf).at(-1) ?? null;
    const mentions = comments.filter((comment) => {
      const body = comment.body ?? "";
      return !fromSelf(comment) && (mentionPattern.test(body) || body.includes(self.url));
    });
    const lastMention = mentions.at(-1) ?? null;
    if (lastMention === null) continue;
    if (lastSelf === null || lastMention.createdAt > lastSelf.createdAt) {
      pending.push({ identifier: issue.identifier, commentId: lastMention.id });
    }
  }
  return pending;
}

export interface BlockedTask {
  id: string;
  identifier: string | null;
  /** Labels of the task and of its direct blockers (one hop). */
  labelNames: string[];
}

export interface BlockedDelta {
  /** Blocked tasks that were not blocked (or were excluded) at the previous check. */
  newlyBlocked: string[];
  /** Set to persist once this check is delivered. */
  nextSeen: string[];
}

/**
 * Propagating a block to Linear is only needed when a task ENTERS `blocked`.
 * Tasks waiting for a prototype merge are skipped by the routine (step 3.b2),
 * so they never count. The first check (no previous set) only records a
 * baseline: whatever was blocked before the gate existed has already been
 * handled by the routine's own scheduled runs.
 */
export function blockedDelta(tasks: BlockedTask[], previousSeen: string[] | null, awaitingMergeLabel: string): BlockedDelta {
  const excluded = awaitingMergeLabel.toLowerCase();
  const eligible = tasks
    .filter((task) => !task.labelNames.some((name) => name.toLowerCase() === excluded))
    .map((task) => task.id)
    .sort();
  if (previousSeen === null) return { newlyBlocked: [], nextSeen: eligible };
  const before = new Set(previousSeen);
  return { newlyBlocked: eligible.filter((id) => !before.has(id)), nextSeen: eligible };
}

export interface PendingWork {
  mentions: PendingMention[];
  intake: string[];
  newlyBlocked: string[];
}

export interface LastFire {
  key: string;
  atMs: number;
}

export type Decision =
  | { fire: false; reason: "idle" }
  | { fire: false; reason: "recently-fired"; key: string }
  | { fire: true; key: string; items: string[] };

/**
 * Fire when anything is pending, unless the exact same pending set was
 * already delivered less than `refireMs` ago (the routine may have decided not
 * to act on an item; re-firing every 5 minutes would burn the plan for nothing).
 */
export function decide(work: PendingWork, last: LastFire | null, nowMs: number, refireMs: number): Decision {
  const items = [
    ...work.mentions.map((mention) => `mention:${mention.identifier}:${mention.commentId}`),
    ...work.intake.map((identifier) => `intake:${identifier}`),
    ...work.newlyBlocked.map((id) => `blocked:${id}`),
  ].sort();
  if (items.length === 0) return { fire: false, reason: "idle" };
  const key = createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 32);
  if (last !== null && last.key === key && nowMs - last.atMs < refireMs) {
    return { fire: false, reason: "recently-fired", key };
  }
  return { fire: true, key, items };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
