// Explicit link between a Paperclip root task and its Linear issue. Every
// task under that root inherits it by walking `parentId` up, so no agent ever
// has to repeat the Linear link in a subtask description.
import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import type { SyncConfig } from "./config.js";
import { readState, writeState } from "./effects.js";
import type { LinearSession } from "./linear.js";
import { isClosed } from "./rules.js";

export interface LinkRecord {
  linearIssueId: string;
  identifier: string;
  url: string;
}

export interface LinkStore {
  /** Paperclip root task id → Linear issue. */
  roots: Record<string, LinkRecord>;
  /** Last full scan of open root tasks for links written in their description. */
  scannedAt: string | null;
}

const LINKS_KEY = "links";
export const RESCAN_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 100;

export const loadLinks = (ctx: PluginContext, companyId: string) => readState<LinkStore>(ctx, companyId, LINKS_KEY, { roots: {}, scannedAt: null });
export const saveLinks = (ctx: PluginContext, companyId: string, store: LinkStore) => writeState(ctx, companyId, LINKS_KEY, store);

/** Linear identifier from a description: the "Linear issue: <url>" line the old routine wrote, or any Linear issue URL. */
export function linearReference(description: string | null): string | null {
  const match = /linear\.app\/[^/\s)]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i.exec(description ?? "");
  return match ? match[1].toUpperCase() : null;
}

/** Linear issue id → its Paperclip root task ids (a Linear issue may be split per repository). */
export function rootsByLinearIssue(store: LinkStore): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [rootId, link] of Object.entries(store.roots)) {
    grouped.set(link.linearIssueId, [...(grouped.get(link.linearIssueId) ?? []), rootId]);
  }
  return grouped;
}

/** Nearest ancestor (or the task itself) that has a Linear link. */
export async function findLinkedRoot(ctx: PluginContext, companyId: string, store: LinkStore, taskId: string): Promise<string | null> {
  const visited = new Set<string>();
  let current: string | null = taskId;
  while (current !== null && !visited.has(current)) {
    if (store.roots[current]) return current;
    visited.add(current);
    const issue: Issue | null = await ctx.issues.get(current, companyId);
    current = issue?.parentId ?? null;
  }
  return null;
}

/**
 * Link open root tasks that point at a Linear issue in their description, or
 * that `manualLinks` maps by hand. Closed roots are left out: there is nothing
 * left to sync for them.
 */
export async function scanRoots(
  ctx: PluginContext,
  companyId: string,
  config: SyncConfig,
  linear: LinearSession,
  store: LinkStore,
  nowIso: string,
): Promise<{ store: LinkStore; linked: string[]; unresolved: string[] }> {
  const roots: Issue[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await ctx.issues.list({ companyId, limit: PAGE_SIZE, offset });
    roots.push(...page.filter((issue) => !issue.parentId && !isClosed(issue.status)));
    if (page.length < PAGE_SIZE) break;
  }
  const manual = new Map(Object.entries(config.manualLinks).map(([task, linearId]) => [task.toUpperCase(), linearId.toUpperCase()]));
  const next: LinkStore = { roots: { ...store.roots }, scannedAt: nowIso };
  const linked: string[] = [];
  const unresolved: string[] = [];
  for (const root of roots) {
    if (next.roots[root.id]) continue;
    const reference = (root.identifier ? manual.get(root.identifier.toUpperCase()) : undefined) ?? linearReference(root.description);
    if (!reference) continue;
    const issue = await linear.issue(reference);
    if (!issue) {
      unresolved.push(`${root.identifier ?? root.id} → ${reference}`);
      continue;
    }
    next.roots[root.id] = { linearIssueId: issue.id, identifier: issue.identifier, url: issue.url };
    linked.push(`${root.identifier ?? root.id} → ${issue.identifier}`);
  }
  return { store: next, linked, unresolved };
}
