import { describe, expect, it } from "vitest";
import {
  blocksReferences,
  descendantsOf,
  diagnoseBlocked,
  emptyPublished,
  fixFollowUps,
  mentionEmails,
  plainTextAgentNames,
  plainTextHandoffs,
  planNotices,
  relayTarget,
  type CommentView,
  type Diagnosis,
  type TaskView,
} from "../src/rules.js";

const agents = [
  { id: "agent-cto", name: "CTO Backend" },
  { id: "agent-dev", name: "Backend Dev Specialist" },
  { id: "agent-tech", name: "Backend Tech Team" },
];
const NOW = Date.parse("2026-10-25T18:00:00Z");

const task = (overrides: Partial<TaskView> & Pick<TaskView, "id">): TaskView => ({
  identifier: overrides.id.toUpperCase(),
  title: overrides.id,
  description: null,
  status: "todo",
  assigneeAgentId: null,
  parentId: null,
  labelNames: [],
  updatedAt: "2026-10-25T14:05:00Z",
  ...overrides,
});
const comment = (overrides: Partial<CommentView> & Pick<CommentView, "id" | "body">): CommentView => ({
  createdAt: "2026-10-25T14:05:00Z",
  authorAgentId: null,
  authorUserId: null,
  ...overrides,
});
const diagnose = (overrides: Partial<Parameters<typeof diagnoseBlocked>[0]> = {}) =>
  diagnoseBlocked({
    task: task({ id: "lab-5055", status: "blocked", assigneeAgentId: "agent-dev" }),
    blockers: [],
    comments: [],
    pendingInteractions: 0,
    agents,
    awaitingMergeLabel: "awaiting-prototype-merge",
    productLabel: "producto",
    staleMinutes: 30,
    nowMs: NOW,
    ...overrides,
  });

describe("diagnoseBlocked", () => {
  it("LAB-5055: waits on the agent it mentioned with agent://, and is stuck after the threshold", () => {
    const result = diagnose({
      comments: [comment({ id: "c1", authorAgentId: "agent-dev", body: "Phase 3 done, 3 test defects. [@CTO Backend](agent://agent-cto) holding my issue blocked pending your call." })],
    });
    expect(result.waitingOn).toEqual({ kind: "agent", agentId: "agent-cto", agentName: "CTO Backend", viaMention: true });
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("holding my issue blocked");
  });

  it("is not stuck while recent, nor while a formal blocker is open", () => {
    expect(diagnose({ nowMs: Date.parse("2026-10-25T14:20:00Z") }).stuck).toBe(false);
    const withBlocker = diagnose({ blockers: [{ id: "b", identifier: "LAB-1", status: "in_progress", assigneeAgentId: "agent-tech", labelNames: [] }] });
    expect(withBlocker.stuck).toBe(false);
    expect(withBlocker.waitingOn.kind).toBe("blockers");
  });

  it("ignores closed blockers and treats a pending question as waiting on a human", () => {
    const result = diagnose({
      blockers: [{ id: "b", identifier: "LAB-1", status: "done", assigneeAgentId: "agent-tech", labelNames: [] }],
      pendingInteractions: 1,
    });
    expect(result.waitingOn).toEqual({ kind: "human" });
    expect(result.stuck).toBe(false);
  });

  it("detects an agent named in plain text, without a mention", () => {
    const result = diagnose({ comments: [comment({ id: "c1", authorAgentId: "agent-dev", body: "Waiting for CTO Backend to decide." })] });
    expect(result.waitingOn).toEqual({ kind: "agent", agentId: "agent-cto", agentName: "CTO Backend", viaMention: false });
  });

  it("excludes tasks waiting for a prototype merge (own label or a blocker's), like routine step 3.b2", () => {
    expect(diagnose({ task: task({ id: "x", status: "blocked", labelNames: ["Awaiting-Prototype-Merge"] }) }).excluded).toBe(true);
    const viaBlocker = diagnose({ blockers: [{ id: "b", identifier: "LAB-2", status: "in_review", assigneeAgentId: null, labelNames: ["awaiting-prototype-merge"] }] });
    expect(viaBlocker.excluded).toBe(true);
  });

  it("marks product questions by label", () => {
    expect(diagnose({ task: task({ id: "x", status: "blocked", labelNames: ["Producto"] }) }).product).toBe(true);
  });
});

describe("plainTextAgentNames", () => {
  it("does not report agents already mentioned with agent://", () => {
    expect(plainTextAgentNames("[CTO Backend](agent://agent-cto) please", agents)).toEqual([]);
  });

  it("finds whole names only", () => {
    expect(plainTextAgentNames("Handing back to Backend Dev Specialist (LAB-5055)", agents).map((agent) => agent.id)).toEqual(["agent-dev"]);
    expect(plainTextAgentNames("the CTO Backendish thing", agents)).toEqual([]);
  });
});

describe("blocksReferences", () => {
  it("reads the LAB-5059 title and Spanish phrasing", () => {
    expect(blocksReferences({ title: "[LAB-4949 · Phase 2 fix] Fix 3 test defects (blocks LAB-5055)", description: null })).toEqual(["LAB-5055"]);
    expect(blocksReferences({ title: "Arreglo", description: "Esta tarea bloquea a LAB-12" })).toEqual(["LAB-12"]);
  });
});

describe("fixFollowUps", () => {
  const blocked = task({ id: "b", identifier: "LAB-5055", status: "blocked", assigneeAgentId: "agent-dev" });
  const GRACE = 30 * 60_000;
  const follow = (tasks: TaskView[], relations: Map<string, string[]>, nowMs = NOW) => fixFollowUps(tasks, relations, nowMs, GRACE);

  it("LAB-5059: a finished fix that says 'blocks LAB-5055' resumes it at once and is announced", () => {
    const fix = task({ id: "f", identifier: "LAB-5059", title: "Fix 3 test defects (blocks LAB-5055)", status: "done", updatedAt: "2026-10-25T17:59:00Z" });
    expect(follow([blocked, fix], new Map())).toEqual({ missingRelations: [], resumes: [{ taskId: "b", fixTaskId: "f", announce: true }] });
  });

  it("creates the missing relation while the fix is still open", () => {
    const fix = task({ id: "f", identifier: "LAB-5059", title: "Fix (blocks LAB-5055)", status: "in_progress" });
    expect(follow([blocked, fix], new Map())).toEqual({ missingRelations: [{ blockedTaskId: "b", blockerTaskId: "f" }], resumes: [] });
  });

  it("does not resume while another blocker is still open", () => {
    const fix = task({ id: "f", identifier: "LAB-5059", status: "done" });
    const other = task({ id: "o", identifier: "LAB-6000", status: "in_progress" });
    expect(follow([blocked, fix, other], new Map([["b", ["f", "o"]]])).resumes).toEqual([]);
  });

  it("gives Paperclip the grace period on a formal relation, then resumes silently", () => {
    const fix = task({ id: "f", identifier: "LAB-5059", status: "done", updatedAt: "2026-10-25T17:45:00Z" });
    expect(follow([blocked, fix], new Map([["b", ["f"]]])).resumes).toEqual([]);
    expect(follow([blocked, fix], new Map([["b", ["f"]]]), Date.parse("2026-10-25T18:16:00Z")).resumes).toEqual([{ taskId: "b", fixTaskId: "f", announce: false }]);
  });

  it("a 'blocks' text that is also a formal relation is Paperclip's to handle first", () => {
    const fix = task({ id: "f", identifier: "LAB-5059", title: "Fix (blocks LAB-5055)", status: "done", updatedAt: "2026-10-25T17:59:00Z" });
    expect(follow([blocked, fix], new Map([["b", ["f"]]])).resumes).toEqual([]);
  });
});

describe("internal blocks", () => {
  it("a parent waiting for its own subtask is internal; a task waiting for a sibling is not", () => {
    const tasks = [task({ id: "p" }), task({ id: "c1", parentId: "p" }), task({ id: "c2", parentId: "p" }), task({ id: "g", parentId: "c1" })];
    const descendants = descendantsOf(tasks);
    expect([...descendants.get("p")!].sort()).toEqual(["c1", "c2", "g"]);
    const open = (id: string) => ({ id, identifier: id, status: "in_progress", assigneeAgentId: null, labelNames: [] });
    expect(diagnose({ task: task({ id: "p", status: "blocked" }), blockers: [open("c1")], descendantIds: descendants.get("p") }).internal).toBe(true);
    expect(diagnose({ task: task({ id: "c2", status: "blocked" }), blockers: [open("c1")], descendantIds: descendants.get("c2") }).internal).toBe(false);
  });
});

describe("plainTextHandoffs", () => {
  const target = task({ id: "b", identifier: "LAB-5055", status: "blocked", assigneeAgentId: "agent-dev" });
  const byIdentifier = new Map([["LAB-5055", target]]);

  it("LAB-5059: 'Handing back to Backend Dev Specialist (LAB-5055)' targets LAB-5055", () => {
    const handoffs = plainTextHandoffs({
      comment: comment({ id: "c9", authorAgentId: "agent-tech", body: "Phase 2 fix COMPLETE. Handing back to Backend Dev Specialist (LAB-5055) for final GREEN confirmation." }),
      fromTaskId: "f",
      agents,
      tasksByIdentifier: byIdentifier,
    });
    expect(handoffs).toEqual([{ commentId: "c9", fromTaskId: "f", targetTaskId: "b", agentId: "agent-dev", agentName: "Backend Dev Specialist" }]);
  });

  it("ignores a proper mention, a human author and the plugin's own comments", () => {
    const base = { fromTaskId: "f", agents, tasksByIdentifier: byIdentifier };
    expect(plainTextHandoffs({ ...base, comment: comment({ id: "c1", authorAgentId: "agent-tech", body: "[Backend Dev Specialist](agent://agent-dev) LAB-5055" }) })).toEqual([]);
    expect(plainTextHandoffs({ ...base, comment: comment({ id: "c2", authorUserId: "u1", body: "Backend Dev Specialist LAB-5055" }) })).toEqual([]);
    expect(plainTextHandoffs({ ...base, comment: comment({ id: "c3", authorAgentId: "agent-tech", body: "Backend Dev Specialist LAB-5055 <!-- linear-sync:handoff:x -->" }) })).toEqual([]);
  });
});

describe("planNotices", () => {
  const blockedDiagnosis = (taskId: string, extra: Partial<Diagnosis> = {}): Diagnosis => ({
    taskId,
    identifier: taskId,
    title: taskId,
    excluded: false,
    internal: false,
    reason: null,
    waitingOn: { kind: "unknown" },
    stuck: false,
    product: false,
    lastActivityAt: "2026-10-25T14:05:00Z",
    ...extra,
  });
  const nowIso = "2026-10-25T18:00:00.000Z";

  it("first pass adopts existing blocks silently but still announces stuck tasks", () => {
    const { notices, next } = planNotices({
      diagnoses: [blockedDiagnosis("a"), blockedDiagnosis("b", { stuck: true })],
      rootsDone: false,
      published: emptyPublished(),
      nowIso,
    });
    expect(notices.map((notice) => notice.kind)).toEqual(["stuck"]);
    expect(Object.keys(next.blocked)).toEqual(["a", "b"]);
    expect(next.baseline).toBe(true);
  });

  it("announces new blocks and unblocks after the baseline, once", () => {
    const published = { ...emptyPublished(), baseline: true, blocked: { a: "a@t0" } };
    const { notices, next } = planNotices({ diagnoses: [blockedDiagnosis("c")], rootsDone: false, published, nowIso });
    expect(notices.map((notice) => notice.kind).sort()).toEqual(["block", "unblock"]);
    expect(planNotices({ diagnoses: [blockedDiagnosis("c")], rootsDone: false, published: next, nowIso }).notices).toEqual([]);
  });

  it("does not announce the unblock of a block that was only adopted, never announced", () => {
    const first = planNotices({ diagnoses: [blockedDiagnosis("a")], rootsDone: false, published: emptyPublished(), nowIso });
    expect(planNotices({ diagnoses: [], rootsDone: false, published: first.next, nowIso }).notices).toEqual([]);
  });

  it("never announces excluded tasks", () => {
    const published = { ...emptyPublished(), baseline: true };
    expect(planNotices({ diagnoses: [blockedDiagnosis("a", { excluded: true })], rootsDone: false, published, nowIso }).notices).toEqual([]);
  });

  it("announces completion once, and again only after a reopen", () => {
    const published = { ...emptyPublished(), baseline: true };
    const first = planNotices({ diagnoses: [], rootsDone: true, published, nowIso });
    expect(first.notices.map((notice) => notice.kind)).toEqual(["done"]);
    expect(planNotices({ diagnoses: [], rootsDone: true, published: first.next, nowIso }).notices).toEqual([]);
    const reopened = planNotices({ diagnoses: [], rootsDone: false, published: first.next, nowIso }).next;
    expect(planNotices({ diagnoses: [], rootsDone: true, published: reopened, nowIso }).notices.map((notice) => notice.kind)).toEqual(["done"]);
  });
});

describe("relayTarget and mentionEmails", () => {
  const d = (taskId: string, kind: "human" | "unknown", lastActivityAt: string): Diagnosis => ({
    taskId,
    identifier: taskId,
    title: taskId,
    excluded: false,
    internal: false,
    reason: null,
    waitingOn: kind === "human" ? { kind: "human" } : { kind: "unknown" },
    stuck: false,
    product: false,
    lastActivityAt,
  });

  it("prefers a task waiting on a human, then the newest blocked task, then an open root", () => {
    const root = task({ id: "root" });
    expect(relayTarget([d("a", "unknown", "2026-10-25T15:00:00Z"), d("b", "human", "2026-10-25T14:00:00Z")], [root])).toBe("b");
    expect(relayTarget([d("a", "unknown", "2026-10-25T15:00:00Z"), d("c", "unknown", "2026-10-25T16:00:00Z")], [root])).toBe("c");
    expect(relayTarget([], [task({ id: "closed", status: "done" }), root])).toBe("root");
  });

  it("routes product questions to product, technical ones by Linear assignee", () => {
    const routing = { product: ["eros@x"], technicalByAssignee: { "jesus@x": ["jesus@x"] }, technicalDefault: ["jesus@x", "rafael@x"] };
    expect(mentionEmails({ ...d("a", "human", ""), product: true }, routing, "jesus@x")).toEqual(["eros@x"]);
    expect(mentionEmails(d("a", "human", ""), routing, "JESUS@x")).toEqual(["jesus@x"]);
    expect(mentionEmails(d("a", "human", ""), routing, null)).toEqual(["jesus@x", "rafael@x"]);
  });
});
