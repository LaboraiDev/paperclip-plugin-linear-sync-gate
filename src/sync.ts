// The sync itself. One entry point per trigger (sweep, Paperclip event,
// Linear webhook); all of them end in `reconcileLinearIssue`, so a lost event
// is fixed by the next sweep with exactly the same logic.
import type { Issue, IssueComment, PluginContext } from "@paperclipai/plugin-sdk";
import type { SyncConfig } from "./config.js";
import { EffectRunner, readState, writeState, type EffectResult } from "./effects.js";
import { pendingMentions, type LinearSelf } from "./gate.js";
import type { LinearIssue, LinearSession } from "./linear.js";
import { findLinkedRoot, loadLinks, RESCAN_MS, rootsByLinearIssue, saveLinks, scanRoots, type LinkStore } from "./links.js";
import {
  descendantsOf,
  diagnoseBlocked,
  emptyPublished,
  fixFollowUps,
  hasPluginMarker,
  isClosed,
  isNews,
  mentionEmails,
  planNotices,
  plainTextHandoffs,
  relayTarget,
  type AgentView,
  type CommentView,
  type Diagnosis,
  type PublishedState,
  type TaskView,
} from "./rules.js";
import {
  blockNotice,
  doneNotice,
  handoffComment,
  noTaskReply,
  relayToPaperclip,
  replyToLinear,
  resumeComment,
  resumedNotice,
  stuckNotice,
  taskUrl,
  unblockNotice,
  type TaskRef,
} from "./templates.js";

export interface SyncContext {
  ctx: PluginContext;
  companyId: string;
  config: SyncConfig;
  linear: LinearSession;
  self: LinearSelf;
  runner: EffectRunner;
  nowMs: number;
  /** Paperclip `originKind` of tasks this plugin creates. */
  originKind: `plugin:${string}`;
}

interface RelayRecord {
  linearIssueId: string;
  /** Top-level Linear comment of the thread the reply must go to. */
  linearThreadId: string;
  taskId: string;
  at: string;
  answered: boolean;
}

/** Comments older than this are never scanned for plain-text handoffs. */
const HANDOFF_WINDOW_MS = 24 * 60 * 60_000;

const iso = (value: Date | string | null | undefined): string => (value instanceof Date ? value.toISOString() : value ?? new Date(0).toISOString());
const nowIso = (sync: SyncContext) => new Date(sync.nowMs).toISOString();
const succeeded = (result: EffectResult) => result.outcome !== "failed";

export function toTaskView(issue: Issue): TaskView {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    parentId: issue.parentId,
    labelNames: (issue.labels ?? []).map((label) => label.name),
    updatedAt: iso(issue.updatedAt),
  };
}

function toCommentView(comment: IssueComment): CommentView {
  return {
    id: comment.id,
    body: comment.body ?? "",
    createdAt: iso(comment.createdAt),
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
  };
}

async function loadAgents(sync: SyncContext): Promise<AgentView[]> {
  const agents = await sync.ctx.agents.list({ companyId: sync.companyId });
  return agents.map((agent) => ({ id: agent.id, name: agent.name }));
}

const publishedKey = (sync: SyncContext) => `published:${sync.config.mode}`;
const relaysKey = (sync: SyncContext) => `relays:${sync.config.mode}`;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface SweepReport {
  linkedIssues: number;
  newLinks: string[];
  unresolvedLinks: string[];
  effects: ReturnType<EffectRunner["counts"]>;
  /** Linear GraphQL calls this sweep made (Linear allows 5,000/hour for an OAuth app). */
  linearCalls: number;
}

/** Full pass: refresh links, intake, reconcile every linked issue, answer mentions on unlinked issues. */
/** Links, rescanned once a day (or right away if they were never scanned). */
async function currentLinks(sync: SyncContext): Promise<{ store: LinkStore; newLinks: string[]; unresolvedLinks: string[] }> {
  const store = await loadLinks(sync.ctx, sync.companyId);
  if (store.scannedAt && sync.nowMs - Date.parse(store.scannedAt) < RESCAN_MS) return { store, newLinks: [], unresolvedLinks: [] };
  const scan = await scanRoots(sync.ctx, sync.companyId, sync.config, sync.linear, store, nowIso(sync));
  await saveLinks(sync.ctx, sync.companyId, scan.store);
  return { store: scan.store, newLinks: scan.linked, unresolvedLinks: scan.unresolved };
}

export async function runSweep(sync: SyncContext): Promise<SweepReport> {
  const links = await currentLinks(sync);
  const { newLinks, unresolvedLinks } = links;
  const store = await intake(sync, links.store, await sync.linear.todoIssues(sync.config.todoStateName, sync.config.readyLabel));

  const groups = rootsByLinearIssue(store);
  for (const [linearIssueId, rootIds] of groups) {
    await reconcileLinearIssue(sync, linearIssueId, rootIds, []);
  }
  await answerUnlinkedMentions(sync, new Set(groups.keys()));
  return { linkedIssues: groups.size, newLinks, unresolvedLinks, effects: sync.runner.counts(), linearCalls: sync.linear.calls() };
}

/** Paperclip tasks changed: reconcile each Linear issue they belong to, once. */
export async function handleTaskEvents(sync: SyncContext, taskIds: string[]): Promise<void> {
  const { store } = await currentLinks(sync);
  const hints = new Map<string, string[]>();
  for (const taskId of new Set(taskIds)) {
    const rootId = await findLinkedRoot(sync.ctx, sync.companyId, store, taskId);
    if (!rootId) continue;
    const linearIssueId = store.roots[rootId].linearIssueId;
    hints.set(linearIssueId, [...(hints.get(linearIssueId) ?? []), taskId]);
  }
  const groups = rootsByLinearIssue(store);
  for (const [linearIssueId, hintTaskIds] of hints) {
    await reconcileLinearIssue(sync, linearIssueId, groups.get(linearIssueId) ?? [], hintTaskIds);
  }
}

export interface LinearWebhookPayload {
  type?: string;
  action?: string;
  data?: { id?: string; issueId?: string };
}

/** A verified Linear webhook: reconcile the issue it touches, or take it in if it is new work. */
export async function handleLinearWebhook(sync: SyncContext, payload: LinearWebhookPayload): Promise<void> {
  const linearIssueId = payload.type === "Comment" ? payload.data?.issueId : payload.type === "Issue" ? payload.data?.id : undefined;
  if (!linearIssueId) return;
  const { store } = await currentLinks(sync);
  const roots = rootsByLinearIssue(store).get(linearIssueId);
  if (roots) {
    await reconcileLinearIssue(sync, linearIssueId, roots, []);
    return;
  }
  if (payload.type !== "Issue") return;
  const issue = await sync.linear.issue(linearIssueId);
  if (!issue) return;
  const ready = issue.labels.nodes.some((label) => label.name.toLowerCase() === sync.config.readyLabel.toLowerCase());
  if (ready && issue.state.name.toLowerCase() === sync.config.todoStateName.toLowerCase()) {
    await intake(sync, store, [issue]);
  }
}

// ---------------------------------------------------------------------------
// Intake: Linear Todo + Ready for AI → Paperclip task (replaces routine step 2)
// ---------------------------------------------------------------------------

function projectFor(issue: LinearIssue, projectMap: Record<string, string>): string | undefined {
  const projects = new Set(issue.labels.nodes.map((label) => projectMap[label.name.toLowerCase()]).filter((id): id is string => Boolean(id)));
  return projects.size === 1 ? [...projects][0] : undefined;
}

async function intake(sync: SyncContext, store: LinkStore, issues: LinearIssue[]): Promise<LinkStore> {
  const linked = new Set(Object.values(store.roots).map((link) => link.linearIssueId));
  let next = store;
  for (const issue of issues) {
    if (linked.has(issue.id)) continue;
    // A previous pass may have created the task and failed before saving the link.
    const [existing] = await sync.ctx.issues.list({ companyId: sync.companyId, originKind: sync.originKind, originId: issue.id, limit: 1 });
    if (existing) {
      next = { ...next, roots: { ...next.roots, [existing.id]: { linearIssueId: issue.id, identifier: issue.identifier, url: issue.url } } };
      await saveLinks(sync.ctx, sync.companyId, next);
      continue;
    }
    // Linear first, exactly like the routine did: an issue already "In Progress" is never taken in twice.
    // Repeatable: the issue is only here while Linear still shows it in Todo (e.g. after a revert).
    const moved = await sync.runner.run({
      kind: "linear.state",
      key: `intake:${issue.id}:in-progress`,
      linearIssueId: issue.id,
      teamId: issue.team.id,
      stateName: sync.config.inProgressStateName,
      repeatable: true,
    });
    if (moved.outcome === "failed" || moved.outcome === "duplicate") continue;
    const projectId = projectFor(issue, sync.config.projectMap);
    const created = await sync.runner.run({
      kind: "paperclip.createIssue",
      key: `intake:${issue.id}:create`,
      input: {
        title: issue.title,
        description: `${issue.description ?? ""}\n\nLinear issue: ${issue.url}`.trim(),
        assigneeAgentId: sync.config.intakeAgentId,
        ...(projectId ? { projectId } : {}),
        originKind: sync.originKind,
        originId: issue.id,
      },
    });
    if (created.outcome === "applied" && created.createdIssue) {
      next = { ...next, roots: { ...next.roots, [created.createdIssue.id]: { linearIssueId: issue.id, identifier: issue.identifier, url: issue.url } } };
      await saveLinks(sync.ctx, sync.companyId, next);
    } else if (created.outcome === "failed") {
      await sync.runner.run({
        kind: "linear.state",
        key: `intake:${issue.id}:revert`,
        linearIssueId: issue.id,
        teamId: issue.team.id,
        stateName: sync.config.todoStateName,
        repeatable: true,
      });
    } else if (created.outcome === "duplicate" && sync.config.mode === "act") {
      sync.ctx.logger.warn("Linear issue was already taken in but its Paperclip task was not found by origin", {
        companyId: sync.companyId,
        linearIssue: issue.identifier,
      });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Reconcile one Linear issue against its Paperclip subtrees
// ---------------------------------------------------------------------------

export async function reconcileLinearIssue(sync: SyncContext, linearIssueId: string, rootIds: string[], hintTaskIds: string[]): Promise<void> {
  const { ctx, companyId, config, runner } = sync;
  const publishedAll = await readState<Record<string, PublishedState>>(ctx, companyId, publishedKey(sync), {});
  const published = publishedAll[linearIssueId] ?? emptyPublished();
  const firstPass = !published.baseline;

  const subtrees = await Promise.all(rootIds.map((rootId) => ctx.issues.getSubtree(rootId, companyId, { includeRelations: true })));
  const issuesById = new Map<string, Issue>();
  const blockedBy = new Map<string, Array<{ id: string; identifier: string | null; status: string; assigneeAgentId: string | null }>>();
  for (const subtree of subtrees) {
    for (const issue of subtree.issues) issuesById.set(issue.id, issue);
    for (const [id, relation] of Object.entries(subtree.relations ?? {})) blockedBy.set(id, relation.blockedBy);
  }
  const tasks = [...issuesById.values()].map(toTaskView);
  const roots = tasks.filter((task) => rootIds.includes(task.id));
  if (roots.length > 0 && roots.every((root) => isClosed(root.status)) && published.done && hintTaskIds.length === 0) return;

  const linearIssue = await sync.linear.issue(linearIssueId);
  if (!linearIssue) {
    ctx.logger.warn("Linked Linear issue not found; skipping", { companyId, linearIssueId });
    return;
  }

  const agents = await loadAgents(sync);
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? "la agente";
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const tasksByIdentifier = new Map(tasks.filter((task) => task.identifier).map((task) => [task.identifier!.toUpperCase(), task]));
  const refOf = (task: TaskView | undefined): TaskRef => ({
    identifier: task?.identifier ?? null,
    title: task?.title ?? "tarea",
    url: taskUrl(config.paperclipUrl, task?.identifier ?? null),
  });

  const fullIssues = new Map<string, Issue | null>();
  const fullIssue = async (id: string) => {
    if (!fullIssues.has(id)) fullIssues.set(id, (await ctx.issues.get(id, companyId)) ?? issuesById.get(id) ?? null);
    return fullIssues.get(id) ?? null;
  };
  const commentCache = new Map<string, CommentView[]>();
  const commentsOf = async (taskId: string) => {
    if (!commentCache.has(taskId)) commentCache.set(taskId, (await ctx.issues.listComments(taskId, companyId)).map(toCommentView));
    return commentCache.get(taskId)!;
  };

  // 1. Diagnose every blocked task in the subtree, whoever it is assigned to.
  const descendants = descendantsOf(tasks);
  const diagnoses: Diagnosis[] = [];
  for (const task of tasks.filter((candidate) => candidate.status === "blocked")) {
    const full = await fullIssue(task.id);
    const view = full ? toTaskView(full) : task;
    const blockers = await Promise.all(
      (blockedBy.get(task.id) ?? []).map(async (blocker) => ({
        ...blocker,
        labelNames: ((await fullIssue(blocker.id))?.labels ?? []).map((label) => label.name),
      })),
    );
    const interactions = await ctx.issues.listInteractions(task.id, companyId);
    diagnoses.push(
      diagnoseBlocked({
        task: view,
        blockers,
        comments: await commentsOf(task.id),
        pendingInteractions: interactions.filter((interaction) => interaction.status === "pending").length,
        agents,
        awaitingMergeLabel: config.awaitingMergeLabel,
        productLabel: config.productLabel,
        staleMinutes: config.staleMinutes,
        nowMs: sync.nowMs,
        descendantIds: descendants.get(task.id),
      }),
    );
  }

  // 2. Self-healing: finished fix tasks, missing relations, plain-text handoffs.
  const resumed = new Set<string>();
  /** Resumed tasks already explained in Linear: no extra "Desbloqueada" for them. */
  const announcedResumes = new Set<string>();
  const resume = async (target: TaskView, keyBase: string, paperclipBody: string, cause: string, announce: boolean) => {
    if (target.status === "blocked") await runner.run({ kind: "paperclip.status", key: `${keyBase}:status`, issueId: target.id, status: "todo" });
    await runner.run({ kind: "paperclip.comment", key: `${keyBase}:comment`, issueId: target.id, body: paperclipBody });
    await runner.run({ kind: "paperclip.wakeup", key: `${keyBase}:wake`, issueId: target.id, reason: cause });
    if (announce) {
      await runner.run({
        kind: "linear.comment",
        key: `${keyBase}:linear`,
        linearIssueId,
        body: resumedNotice({ task: refOf(target), cause, key: keyBase }),
      });
      announcedResumes.add(target.id);
    }
    resumed.add(target.id);
  };

  const followUps = fixFollowUps(
    tasks,
    new Map([...blockedBy].map(([id, list]) => [id, list.map((blocker) => blocker.id)])),
    sync.nowMs,
    config.staleMinutes * 60_000,
  );
  for (const missing of followUps.missingRelations) {
    await runner.run({
      kind: "paperclip.blockers",
      key: `relation:${missing.blockedTaskId}:${missing.blockerTaskId}`,
      issueId: missing.blockedTaskId,
      add: [missing.blockerTaskId],
    });
  }
  for (const { taskId, fixTaskId, announce } of followUps.resumes) {
    const target = tasksById.get(taskId)!;
    const fix = tasksById.get(fixTaskId)!;
    const keyBase = `resume:${taskId}:${fixTaskId}`;
    await resume(target, keyBase, resumeComment({ fix: refOf(fix), key: keyBase }), `${fix.identifier ?? "La tarea de arreglo"} ya terminó y nadie avisó a esta tarea.`, announce);
  }

  const handoffSources = tasks.filter(
    (task) => hintTaskIds.includes(task.id) || sync.nowMs - Date.parse(task.updatedAt) <= HANDOFF_WINDOW_MS,
  );
  for (const source of handoffSources) {
    for (const comment of await commentsOf(source.id)) {
      if (sync.nowMs - Date.parse(comment.createdAt) > HANDOFF_WINDOW_MS) continue;
      for (const handoff of plainTextHandoffs({ comment, fromTaskId: source.id, agents, tasksByIdentifier })) {
        const target = tasksById.get(handoff.targetTaskId)!;
        if (target.status !== "blocked" || resumed.has(target.id)) continue;
        const keyBase = `handoff:${handoff.commentId}:${target.id}`;
        await resume(
          target,
          keyBase,
          handoffComment({ agentId: handoff.agentId, agentName: handoff.agentName, from: refOf(source), quote: comment.body, key: keyBase }),
          `${source.identifier ?? "Otra tarea"} le devolvió el trabajo a ${handoff.agentName} nombrándola sin mencionarla.`,
          true,
        );
      }
    }
  }

  // 3. Linear → Paperclip: relay new human comments to the right task.
  const relays = await readState<Record<string, RelayRecord>>(ctx, companyId, relaysKey(sync), {});
  const linearComments = await sync.linear.issueComments(linearIssueId);
  let relayCursor = published.relayCursor;
  if (firstPass) {
    relayCursor = linearComments.map((comment) => comment.createdAt).sort().at(-1) ?? nowIso(sync);
  } else {
    const fresh = linearComments
      .filter((comment) => relayCursor === null || comment.createdAt > relayCursor)
      .filter((comment) => comment.user?.id !== sync.self.id && !hasPluginMarker(comment.body) && (comment.body ?? "").trim() !== "")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const open = diagnoses.filter((diagnosis) => !resumed.has(diagnosis.taskId));
    for (const comment of fresh) {
      const targetId = relayTarget(open, roots);
      if (!targetId) break;
      const email = comment.user?.email?.toLowerCase() ?? null;
      const mapped = email ? config.userMap[email] : undefined;
      // A human answer only lifts a block that was waiting on a person (or on nobody in particular).
      // Blocked on a task or another agent: the comment alone wakes the assignee; the block stays.
      const waiting = open.find((diagnosis) => diagnosis.taskId === targetId)?.waitingOn.kind;
      if (tasksById.get(targetId)?.status === "blocked" && (waiting === "human" || waiting === "unknown")) {
        await runner.run({ kind: "paperclip.status", key: `relay:${comment.id}:status`, issueId: targetId, status: "todo" });
      }
      const relayed = await runner.run({
        kind: "paperclip.comment",
        key: `relay:${comment.id}`,
        issueId: targetId,
        actorUserId: mapped ?? config.relayFallbackUserId,
        body: relayToPaperclip({
          authorName: comment.user?.name ?? "Alguien",
          linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url,
          body: comment.body ?? "",
          fallback: !mapped,
          commentId: comment.id,
        }),
      });
      if (!succeeded(relayed)) break;
      relays[targetId] = { linearIssueId, linearThreadId: comment.parent?.id ?? comment.id, taskId: targetId, at: nowIso(sync), answered: false };
      relayCursor = comment.createdAt;
    }
  }

  // 4. Paperclip → Linear: the agent's first answer after a relay goes back to the thread.
  for (const relay of Object.values(relays)) {
    if (relay.linearIssueId !== linearIssueId || relay.answered || !tasksById.has(relay.taskId)) continue;
    const answer = (await commentsOf(relay.taskId))
      .filter((comment) => comment.authorAgentId !== null && comment.createdAt > relay.at && !hasPluginMarker(comment.body))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (!answer) continue;
    const posted = await runner.run({
      kind: "linear.comment",
      key: `reply:${answer.id}`,
      linearIssueId,
      parentId: relay.linearThreadId,
      body: replyToLinear({ agentName: agentName(answer.authorAgentId), task: refOf(tasksById.get(relay.taskId)), body: answer.body, key: answer.id }),
    });
    if (succeeded(posted)) relays[relay.taskId] = { ...relay, answered: true };
  }

  // 5. Blocks, unblocks, stuck tasks and completion, announced once each.
  const effective = diagnoses.map((diagnosis) => (resumed.has(diagnosis.taskId) ? { ...diagnosis, stuck: false } : diagnosis));
  const { notices, next } = planNotices({
    diagnoses: effective.filter((diagnosis) => !resumed.has(diagnosis.taskId)),
    rootsDone: roots.length > 0 && roots.every((root) => root.status === "done"),
    published,
    nowIso: nowIso(sync),
  });
  const mentionUrls = async (diagnosis: Diagnosis) => {
    const urls: string[] = [];
    for (const email of mentionEmails(diagnosis, config.routing, linearIssue.assignee?.email ?? null)) {
      const url = await sync.linear.userUrlByEmail(email);
      if (url) urls.push(url);
    }
    return urls;
  };
  const needsHuman = (diagnosis: Diagnosis) => diagnosis.waitingOn.kind === "human" || diagnosis.waitingOn.kind === "unknown";
  for (const notice of notices) {
    if (notice.kind === "block") {
      const task = tasksById.get(notice.diagnosis.taskId);
      await runner.run({
        kind: "linear.comment",
        key: `block:${notice.episode}`,
        linearIssueId,
        body: blockNotice({
          task: refOf(task),
          diagnosis: notice.diagnosis,
          mentionUrls: needsHuman(notice.diagnosis) ? await mentionUrls(notice.diagnosis) : [],
          episode: notice.episode,
        }),
      });
    } else if (notice.kind === "unblock") {
      if (announcedResumes.has(notice.taskId)) continue;
      await runner.run({ kind: "linear.comment", key: `unblock:${notice.episode}`, linearIssueId, body: unblockNotice({ task: refOf(tasksById.get(notice.taskId)), episode: notice.episode }) });
    } else if (notice.kind === "stuck") {
      await runner.run({
        kind: "linear.comment",
        key: `stuck:${notice.episode}`,
        linearIssueId,
        body: stuckNotice({
          task: refOf(tasksById.get(notice.diagnosis.taskId)),
          diagnosis: notice.diagnosis,
          minutes: config.staleMinutes,
          mentionUrls: await mentionUrls(notice.diagnosis),
          episode: notice.episode,
        }),
      });
    } else {
      await runner.run({ kind: "linear.comment", key: `done:${linearIssueId}:${notice.episode}`, linearIssueId, body: doneNotice({ roots: roots.map(refOf), episode: notice.episode }) });
    }
  }

  // 6. The Blocked label follows the subtree (after the first pass, and never on closed Linear issues).
  if (!firstPass) {
    const wantLabel = effective.some((diagnosis) => isNews(diagnosis) && !resumed.has(diagnosis.taskId));
    const hasLabel = linearIssue.labels.nodes.some((label) => label.name.toLowerCase() === config.blockedLabel.toLowerCase());
    const open = !["completed", "canceled"].includes(linearIssue.state.type);
    if (wantLabel !== hasLabel && (wantLabel || open)) {
      await runner.run({
        kind: "linear.labels",
        key: `labels:${linearIssueId}:${wantLabel ? "add" : "remove"}`,
        linearIssueId,
        add: wantLabel ? [config.blockedLabel] : [],
        remove: wantLabel ? [] : [config.blockedLabel],
        repeatable: true,
      });
    }
  }

  if (firstPass) {
    ctx.logger.info("Linear sync: adopted the current state without announcing it", {
      companyId,
      linearIssue: linearIssue.identifier,
      blockedAdopted: Object.keys(next.blocked).length,
      stuckAnnounced: Object.keys(next.stuck).length,
    });
  }
  await writeState(ctx, companyId, publishedKey(sync), { ...publishedAll, [linearIssueId]: { ...next, relayCursor } });
  await writeState(ctx, companyId, relaysKey(sync), relays);
}

// ---------------------------------------------------------------------------
// Mentions of the app on Ready for AI issues that have no Paperclip task
// ---------------------------------------------------------------------------

async function answerUnlinkedMentions(sync: SyncContext, linkedLinearIds: Set<string>): Promise<void> {
  const seenKey = `unlinked-seen:${sync.config.mode}`;
  const seen = await readState<string[] | null>(sync.ctx, sync.companyId, seenKey, null);
  const issues = (await sync.linear.issuesWithComments(sync.config.readyLabel)).filter((issue) => !linkedLinearIds.has(issue.id));
  const issueIds = new Map(issues.map((issue) => [issue.identifier, issue.id]));
  const mentions = pendingMentions(issues, sync.self);
  if (seen === null) {
    // First pass: old unanswered mentions belong to the retired routine; do not answer them now.
    await writeState(sync.ctx, sync.companyId, seenKey, mentions.map((mention) => mention.commentId));
    return;
  }
  const next = new Set(seen);
  for (const mention of mentions) {
    if (next.has(mention.commentId)) continue;
    const result = await sync.runner.run({
      kind: "linear.comment",
      key: `no-task:${mention.commentId}`,
      linearIssueId: issueIds.get(mention.identifier)!,
      body: noTaskReply({ commentId: mention.commentId }),
    });
    if (succeeded(result)) next.add(mention.commentId);
  }
  await writeState(sync.ctx, sync.companyId, seenKey, [...next]);
}
