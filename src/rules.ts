// Pure decision logic for the sync. No I/O: everything read from Paperclip or
// Linear is passed in, so every rule here is unit-tested directly.

/** Marker the plugin appends to every comment it writes, in Linear and in Paperclip. */
export const MARKER_PREFIX = "<!-- linear-sync:";

export const hasPluginMarker = (body: string | null | undefined) => (body ?? "").includes(MARKER_PREFIX);

export interface TaskView {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  assigneeAgentId: string | null;
  parentId: string | null;
  labelNames: string[];
  updatedAt: string;
}

export interface CommentView {
  id: string;
  body: string;
  createdAt: string;
  authorAgentId: string | null;
  authorUserId: string | null;
}

export interface BlockerView {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  labelNames: string[];
}

export interface AgentView {
  id: string;
  name: string;
}

export type WaitingOn =
  | { kind: "blockers"; blockers: Array<{ id: string; identifier: string | null; assigneeAgentId: string | null }> }
  | { kind: "agent"; agentId: string; agentName: string; viaMention: boolean }
  | { kind: "human" }
  | { kind: "unknown" };

export interface Diagnosis {
  taskId: string;
  identifier: string | null;
  title: string;
  /** Waiting for a prototype merge (own label or a direct blocker's): never shown as Blocked in Linear. */
  excluded: boolean;
  /**
   * Only waiting for its own open subtasks (a parent waiting for its
   * children): normal progress, not news for Linear. Waiting for a sibling,
   * like a fix task, is still news.
   */
  internal: boolean;
  /** Last thing the assignee wrote, trimmed. */
  reason: string | null;
  waitingOn: WaitingOn;
  /** Nothing blocks it formally, nobody was asked anything, and it has been idle past the threshold. */
  stuck: boolean;
  /** Carries the product label: a product/design question. */
  product: boolean;
  lastActivityAt: string;
}

const CLOSED_STATUSES = new Set(["done", "cancelled"]);
export const isClosed = (status: string) => CLOSED_STATUSES.has(status);

const AGENT_MENTION_LINK = /\[[^\]]*]\(agent:\/\/([^)\s?]+)[^)]*\)/gi;
const ISSUE_IDENTIFIER = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
/** "blocks LAB-5055", "(bloquea a LAB-5055)", "unblocks LAB-5055". */
const BLOCKS_REFERENCE = /\b(?:un)?blocks\s+([A-Z][A-Z0-9]*-\d+)|\b(?:des)?bloquea(?:\s+a)?\s+([A-Z][A-Z0-9]*-\d+)/gi;

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Agent ids mentioned with a real `[name](agent://id)` link, in order. */
export function mentionedAgentIds(body: string): string[] {
  return [...body.matchAll(AGENT_MENTION_LINK)].map((match) => match[1]);
}

/**
 * Agents named in plain text (outside `agent://` links). Longest names win so
 * "CTO Backend" inside "CTO Backend Lead" is not reported twice.
 */
export function plainTextAgentNames(body: string, agents: AgentView[]): AgentView[] {
  let text = body.replace(AGENT_MENTION_LINK, " ");
  const found: AgentView[] = [];
  for (const agent of [...agents].sort((a, b) => b.name.length - a.name.length)) {
    const name = agent.name.trim();
    if (name.length < 3) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");
    if (pattern.test(text)) {
      found.push(agent);
      text = text.replace(pattern, " ");
    }
  }
  return found;
}

/** Every task's descendants (children, grandchildren…) within the given tasks. */
export function descendantsOf(tasks: Pick<TaskView, "id" | "parentId">[]): Map<string, Set<string>> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task.id]);
  }
  const result = new Map<string, Set<string>>();
  for (const task of tasks) {
    const found = new Set<string>();
    const stack = [...(children.get(task.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (found.has(id)) continue;
      found.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    result.set(task.id, found);
  }
  return result;
}

export function issueIdentifiers(text: string): string[] {
  return [...new Set([...text.matchAll(ISSUE_IDENTIFIER)].map((match) => match[1].toUpperCase()))];
}

/** Identifiers a task says it blocks ("blocks LAB-5055" in its title or description). */
export function blocksReferences(task: Pick<TaskView, "title" | "description">): string[] {
  const text = `${task.title}\n${task.description ?? ""}`;
  return [...new Set([...text.matchAll(BLOCKS_REFERENCE)].map((match) => (match[1] ?? match[2]).toUpperCase()))];
}

export function diagnoseBlocked(input: {
  task: TaskView;
  blockers: BlockerView[];
  comments: CommentView[];
  pendingInteractions: number;
  agents: AgentView[];
  awaitingMergeLabel: string;
  productLabel: string;
  staleMinutes: number;
  nowMs: number;
  /** Ids of the task's own descendants; a block only by them is internal. */
  descendantIds?: Set<string>;
}): Diagnosis {
  const { task } = input;
  const lower = (names: string[]) => names.map((name) => name.toLowerCase());
  const excluded = [task.labelNames, ...input.blockers.map((blocker) => blocker.labelNames)].some((names) =>
    lower(names).includes(input.awaitingMergeLabel.toLowerCase()),
  );
  const comments = [...input.comments].filter((comment) => !hasPluginMarker(comment.body)).sort((a, b) => compare(a.createdAt, b.createdAt));
  const ownLast = comments.filter((comment) => task.assigneeAgentId !== null && comment.authorAgentId === task.assigneeAgentId).at(-1) ?? null;
  const lastActivityAt = [task.updatedAt, ...input.comments.map((comment) => comment.createdAt)].sort(compare).at(-1) ?? task.updatedAt;
  const activeBlockers = input.blockers.filter((blocker) => !isClosed(blocker.status));

  let waitingOn: WaitingOn = { kind: "unknown" };
  if (activeBlockers.length > 0) {
    waitingOn = { kind: "blockers", blockers: activeBlockers.map(({ id, identifier, assigneeAgentId }) => ({ id, identifier, assigneeAgentId })) };
  } else if (input.pendingInteractions > 0) {
    waitingOn = { kind: "human" };
  } else if (ownLast) {
    const others = input.agents.filter((agent) => agent.id !== task.assigneeAgentId);
    const mentioned = mentionedAgentIds(ownLast.body)
      .map((id) => others.find((agent) => agent.id === id))
      .find((agent): agent is AgentView => agent !== undefined);
    const named = plainTextAgentNames(ownLast.body, others)[0];
    if (mentioned) waitingOn = { kind: "agent", agentId: mentioned.id, agentName: mentioned.name, viaMention: true };
    else if (named) waitingOn = { kind: "agent", agentId: named.id, agentName: named.name, viaMention: false };
  }

  const idleMs = input.nowMs - Date.parse(lastActivityAt);
  const stuck = activeBlockers.length === 0 && input.pendingInteractions === 0 && idleMs >= input.staleMinutes * 60_000;
  // Formal blockers that are all its own subtasks, open or already closed (then Paperclip, or the
  // silent resume after the grace period, takes it from there).
  const internal = input.blockers.length > 0 && input.descendantIds !== undefined && input.blockers.every((blocker) => input.descendantIds!.has(blocker.id));
  return {
    taskId: task.id,
    identifier: task.identifier,
    title: task.title,
    excluded,
    internal,
    reason: ownLast ? excerpt(ownLast.body, 300) : null,
    waitingOn,
    stuck,
    product: lower(task.labelNames).includes(input.productLabel.toLowerCase()),
    lastActivityAt,
  };
}

export interface FixFollowUps {
  /** Formal relations the text announces but nobody created. */
  missingRelations: Array<{ blockedTaskId: string; blockerTaskId: string }>;
  /**
   * Blocked tasks whose fix task is done and that nothing else blocks.
   * `announce`: the link was only written in text, so Paperclip could not
   * know; worth telling Linear. Formal relations are Paperclip's own
   * business (often a parent waiting for a subtask) and are healed silently.
   */
  resumes: Array<{ taskId: string; fixTaskId: string; announce: boolean }>;
}

/**
 * The LAB-5055 pattern: a fix task says "blocks LAB-B", finishes, and B stays
 * blocked because nobody told it. Resumed right away, since Paperclip cannot
 * see a link that only exists in text. When the link is a formal relation,
 * Paperclip gets `graceMs` after the blocker closes to resume B itself.
 */
export function fixFollowUps(tasks: TaskView[], blockedByIds: Map<string, string[]>, nowMs: number, graceMs: number): FixFollowUps {
  const byIdentifier = new Map(tasks.filter((task) => task.identifier).map((task) => [task.identifier!.toUpperCase(), task]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const missingRelations: FixFollowUps["missingRelations"] = [];
  const resumes: FixFollowUps["resumes"] = [];
  const pairs = new Map<string, { blocked: TaskView; fix: TaskView; formal: boolean; textual: boolean }>();

  for (const fix of tasks) {
    for (const reference of blocksReferences(fix)) {
      const blocked = byIdentifier.get(reference);
      if (!blocked || blocked.id === fix.id) continue;
      const formal = (blockedByIds.get(blocked.id) ?? []).includes(fix.id);
      pairs.set(`${blocked.id}|${fix.id}`, { blocked, fix, formal, textual: true });
    }
  }
  for (const [blockedId, blockerIds] of blockedByIds) {
    const blocked = byId.get(blockedId);
    for (const blockerId of blockerIds) {
      const fix = byId.get(blockerId);
      const key = `${blockedId}|${blockerId}`;
      if (blocked && fix && !pairs.has(key)) pairs.set(key, { blocked, fix, formal: true, textual: false });
      else if (pairs.has(key)) pairs.get(key)!.formal = true;
    }
  }

  for (const { blocked, fix, formal, textual } of pairs.values()) {
    if (isClosed(blocked.status)) continue;
    if (!formal && !isClosed(fix.status)) {
      missingRelations.push({ blockedTaskId: blocked.id, blockerTaskId: fix.id });
      continue;
    }
    if (fix.status !== "done" || blocked.status !== "blocked") continue;
    if (formal && nowMs - Date.parse(fix.updatedAt) < graceMs) continue;
    const otherActive = (blockedByIds.get(blocked.id) ?? [])
      .filter((id) => id !== fix.id)
      .some((id) => {
        const other = byId.get(id);
        return other === undefined || !isClosed(other.status);
      });
    if (!otherActive) resumes.push({ taskId: blocked.id, fixTaskId: fix.id, announce: textual && !formal });
  }
  return { missingRelations, resumes };
}

export interface Handoff {
  commentId: string;
  fromTaskId: string;
  targetTaskId: string;
  agentId: string;
  agentName: string;
}

/**
 * An agent hands work back by naming another agent in plain text ("Handing
 * back to Backend Dev Specialist (LAB-5055)") instead of a real
 * `agent://` mention, so nobody is woken. Detect the target task: a task the
 * comment cites that is assigned to the named agent and still open.
 */
export function plainTextHandoffs(input: {
  comment: CommentView;
  fromTaskId: string;
  agents: AgentView[];
  tasksByIdentifier: Map<string, TaskView>;
}): Handoff[] {
  const { comment } = input;
  if (comment.authorAgentId === null || hasPluginMarker(comment.body)) return [];
  const named = plainTextAgentNames(comment.body, input.agents.filter((agent) => agent.id !== comment.authorAgentId));
  if (named.length === 0) return [];
  const handoffs: Handoff[] = [];
  for (const identifier of issueIdentifiers(comment.body)) {
    const target = input.tasksByIdentifier.get(identifier);
    if (!target || target.id === input.fromTaskId || isClosed(target.status)) continue;
    const agent = named.find((candidate) => candidate.id === target.assigneeAgentId);
    if (agent) handoffs.push({ commentId: comment.id, fromTaskId: input.fromTaskId, targetTaskId: target.id, agentId: agent.id, agentName: agent.name });
  }
  return handoffs;
}

export interface PublishedState {
  /** False until the first pass in the current mode recorded what already existed. */
  baseline: boolean;
  /** Blocked tasks already announced in Linear: task id → episode key. */
  blocked: Record<string, string>;
  /** Stuck tasks already announced: task id → episode key. */
  stuck: Record<string, string>;
  /** "Finished in Paperclip" already announced. */
  done: boolean;
  /** createdAt of the newest Linear comment already relayed to Paperclip. */
  relayCursor: string | null;
}

export const emptyPublished = (): PublishedState => ({ baseline: false, blocked: {}, stuck: {}, done: false, relayCursor: null });

/** A block Linear should hear about: not waiting for a prototype merge, not a parent waiting for its own subtasks. */
export const isNews = (diagnosis: Diagnosis) => !diagnosis.excluded && !diagnosis.internal;

const ADOPTED = "adopted:";

export type Notice =
  | { kind: "block"; diagnosis: Diagnosis; episode: string }
  | { kind: "unblock"; taskId: string; episode: string }
  | { kind: "stuck"; diagnosis: Diagnosis; episode: string }
  | { kind: "done"; episode: string };

/**
 * What Linear has to be told, given what it was already told. The first pass
 * in a mode adopts the current state silently (no flood of old blocks) except
 * for stuck tasks, which are exactly what nobody noticed.
 */
export function planNotices(input: {
  diagnoses: Diagnosis[];
  rootsDone: boolean;
  published: PublishedState;
  nowIso: string;
}): { notices: Notice[]; next: PublishedState } {
  const current = input.diagnoses.filter(isNews);
  const next: PublishedState = { ...input.published, baseline: true, blocked: {}, stuck: {} };
  const notices: Notice[] = [];
  const firstPass = !input.published.baseline;

  for (const diagnosis of current) {
    const known = input.published.blocked[diagnosis.taskId];
    // Adopted episodes were never announced, so their unblock is not announced either.
    const episode = known ?? `${firstPass ? ADOPTED : ""}${diagnosis.taskId}@${input.nowIso}`;
    next.blocked[diagnosis.taskId] = episode;
    if (!known && !firstPass) notices.push({ kind: "block", diagnosis, episode });
    if (diagnosis.stuck) {
      const stuckKnown = input.published.stuck[diagnosis.taskId];
      next.stuck[diagnosis.taskId] = stuckKnown ?? episode;
      if (!stuckKnown) notices.push({ kind: "stuck", diagnosis, episode });
    }
  }
  if (!firstPass) {
    for (const [taskId, episode] of Object.entries(input.published.blocked)) {
      if (!(taskId in next.blocked) && !episode.startsWith(ADOPTED)) notices.push({ kind: "unblock", taskId, episode });
    }
  }
  if (input.rootsDone && !input.published.done) {
    if (!firstPass) notices.push({ kind: "done", episode: input.nowIso });
    next.done = true;
  } else if (!input.rootsDone) {
    next.done = false;
  }
  return { notices, next };
}

/** Which blocked task a human comment from Linear should land on. */
export function relayTarget(diagnoses: Diagnosis[], roots: TaskView[]): string | null {
  const open = diagnoses.filter(isNews);
  const newest = (list: Diagnosis[]) => [...list].sort((a, b) => compare(b.lastActivityAt, a.lastActivityAt))[0];
  const human = newest(open.filter((diagnosis) => diagnosis.waitingOn.kind === "human"));
  if (human) return human.taskId;
  const any = newest(open);
  if (any) return any.taskId;
  return (roots.find((root) => !isClosed(root.status)) ?? roots[0])?.id ?? null;
}

/** Emails to mention when a human has to act on this blocked task. */
export function mentionEmails(diagnosis: Diagnosis, routing: { product: string[]; technicalByAssignee: Record<string, string[]>; technicalDefault: string[] }, linearAssigneeEmail: string | null): string[] {
  if (diagnosis.product) return routing.product;
  const byAssignee = linearAssigneeEmail ? routing.technicalByAssignee[linearAssigneeEmail.toLowerCase()] : undefined;
  return byAssignee ?? routing.technicalDefault;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
