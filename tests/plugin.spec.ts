import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, IssueComment, PluginAccessMember } from "@paperclipai/plugin-sdk";
import manifest, { LINEAR_WEBHOOK_KEY, SWEEP_JOB_KEY } from "../src/manifest.js";
import plugin, { drainEvents } from "../src/worker.js";
import { LINEAR_APP_SCOPE } from "../src/linear.js";
import { stateKey } from "../src/effects.js";
import { FakeLinear } from "./fakes/linear.js";

// `@paperclipai/shared` is not a direct dependency; take the type from the harness.
type IssueThreadInteraction = NonNullable<Parameters<TestHarness["seed"]>[0]["issueInteractions"]>[number];

const COMPANY = "company-1";
const T0 = "2026-10-25T18:00:00.000Z";
const ref = (secretId: string) => ({ type: "secret_ref", secretId });
// The harness resolves any secret ref to `resolved:<ref>`.
const WEBHOOK_SECRET = `resolved:${String(ref("webhook"))}`;

const baseConfig = {
  enabled: true,
  mode: "act",
  intakeAgentId: "agent-ceo",
  linearClientId: ref("client-id"),
  linearClientSecret: ref("client-secret"),
  linearWebhookSecret: ref("webhook"),
  relayFallbackUserId: "user-jesus",
  userMap: { "eros@x.com": "user-eros" },
  projectMap: { Backend: "project-api" },
  routing: { product: ["eros@x.com"], technicalByAssignee: {}, technicalDefault: ["jesus@x.com"] },
  paperclipUrl: "https://paperclip.test",
};

const agents = [
  { id: "agent-ceo", name: "Programing CEO" },
  { id: "agent-cto", name: "CTO Backend" },
  { id: "agent-dev", name: "Backend Dev Specialist" },
  { id: "agent-tech", name: "Backend Tech Team" },
].map((agent) => ({ ...agent, companyId: COMPANY, status: "idle" }) as unknown as Agent);

const members = ["user-jesus", "user-eros"].map(
  (principalId) => ({ id: `m-${principalId}`, companyId: COMPANY, principalType: "user", principalId, status: "active", membershipRole: "owner" }) as unknown as PluginAccessMember,
);

interface TaskSeed {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  status?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  labels?: string[];
  updatedAt?: string;
}

const task = (seed: TaskSeed) =>
  ({
    companyId: COMPANY,
    identifier: seed.identifier ?? seed.id.toUpperCase(),
    title: seed.title ?? seed.id,
    description: seed.description ?? null,
    status: seed.status ?? "todo",
    parentId: seed.parentId ?? null,
    assigneeAgentId: seed.assigneeAgentId ?? null,
    labels: (seed.labels ?? []).map((name) => ({ id: name, companyId: COMPANY, name })),
    createdAt: new Date("2026-10-20T00:00:00Z"),
    updatedAt: new Date(seed.updatedAt ?? "2026-10-25T14:05:00Z"),
    id: seed.id,
  }) as unknown as Issue;

const comment = (id: string, issueId: string, body: string, author: { agent?: string; user?: string }, createdAt: string) =>
  ({
    id,
    companyId: COMPANY,
    issueId,
    authorType: author.agent ? "agent" : "user",
    authorAgentId: author.agent ?? null,
    authorUserId: author.user ?? null,
    body,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  }) as unknown as IssueComment;

const linearLink = (identifier: string) => `Brief.\n\nLinear issue: https://linear.app/laborai/issue/${identifier}/x`;

let linear: FakeLinear;

async function harnessWith(input: { tasks?: Issue[]; comments?: IssueComment[]; interactions?: IssueThreadInteraction[]; config?: Record<string, unknown> } = {}): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config: { ...baseConfig, ...input.config } });
  harness.seed({
    companies: [{ id: COMPANY, name: "Laborai" } as unknown as Company],
    agents,
    accessMembers: members,
    issues: input.tasks ?? [],
    issueComments: input.comments ?? [],
    issueInteractions: input.interactions ?? [],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const sweep = (harness: TestHarness) => harness.runJob(SWEEP_JOB_KEY);
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const commentsOn = async (harness: TestHarness, issueId: string) => harness.ctx.issues.listComments(issueId, COMPANY);
const statusOf = async (harness: TestHarness, issueId: string) => (await harness.ctx.issues.get(issueId, COMPANY))?.status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  linear = new FakeLinear();
  linear.users.set("jesus@x.com", "https://linear.app/laborai/profiles/jesus");
  linear.users.set("eros@x.com", "https://linear.app/laborai/profiles/eros");
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => linear.handle(url, init));
});

afterEach(async () => {
  await drainEvents();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("manifest", () => {
  it("declares the sweep, the Linear webhook and the event subscription", () => {
    expect(manifest.jobs).toEqual([expect.objectContaining({ jobKey: SWEEP_JOB_KEY, schedule: "*/5 * * * *" })]);
    expect(manifest.webhooks).toEqual([expect.objectContaining({ endpointKey: LINEAR_WEBHOOK_KEY })]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["events.subscribe", "webhooks.receive", "issues.wakeup", "issue.comments.create_human_attributed"]));
  });
});

describe("Linear token", () => {
  it("is requested with the exact scopes of linear-app-actor.sh and always revoked", async () => {
    const harness = await harnessWith();
    await sweep(harness);
    const params = new URLSearchParams(linear.tokenBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe(LINEAR_APP_SCOPE);
    expect(linear.revoked).toBe(linear.tokenBodies.length);
  });

  it("fails the sweep without writing anything when Linear rejects the token", async () => {
    linear.tokenStatus = 401;
    const harness = await harnessWith();
    await expect(sweep(harness)).rejects.toThrow(/HTTP 401/);
    expect(linear.mutations).toEqual([]);
  });

  it("does nothing for a company that has not enabled the sync", async () => {
    const harness = await harnessWith({ config: { enabled: false } });
    await sweep(harness);
    expect(linear.tokenBodies).toEqual([]);
  });
});

describe("N2 intake", () => {
  it("moves the Linear issue to In Progress first, then creates the task with the explicit link and project", async () => {
    linear.addIssue({ id: "lin-1", identifier: "DEV-1", title: "Nueva función", description: "Detalle", stateName: "Todo", labels: ["Ready for AI", "Backend"] });
    const harness = await harnessWith();
    await sweep(harness);
    await sweep(harness);
    expect(linear.find("lin-1")!.stateName).toBe("In Progress");
    const created = await harness.ctx.issues.list({ companyId: COMPANY, originId: "lin-1" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Nueva función", assigneeAgentId: "agent-ceo", projectId: "project-api" });
    expect(created[0].description).toContain("Linear issue: https://linear.app/laborai/issue/DEV-1/x");
  });

  it("N15 observe mode writes nothing and records what it would do", async () => {
    linear.addIssue({ id: "lin-1", identifier: "DEV-1", stateName: "Todo", labels: ["Ready for AI"] });
    const harness = await harnessWith({ config: { mode: "observe" } });
    await sweep(harness);
    expect(linear.mutations).toEqual([]);
    expect(linear.find("lin-1")!.stateName).toBe("Todo");
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originId: "lin-1" })).toEqual([]);
    const observed = harness.getState(stateKey(COMPANY, "observed")) as Array<{ kind: string }>;
    expect(observed.map((entry) => entry.kind)).toEqual(["linear.state", "paperclip.createIssue"]);
  });
});

describe("LAB-5055 scenario (N1, N9, N11, N16)", () => {
  // DEV-2103 ↔ LAB-4948 → LAB-4949 (CTO) → LAB-5055 (Dev, blocked) + LAB-5059 (Tech, done, "blocks LAB-5055").
  function world() {
    linear.addIssue({ id: "lin-2103", identifier: "DEV-2103" });
    const tasks = [
      task({ id: "lab-4948", identifier: "LAB-4948", description: linearLink("DEV-2103"), status: "in_progress", assigneeAgentId: "agent-ceo" }),
      task({ id: "lab-4949", identifier: "LAB-4949", parentId: "lab-4948", status: "blocked", assigneeAgentId: "agent-cto" }),
      task({ id: "lab-5055", identifier: "LAB-5055", parentId: "lab-4949", status: "blocked", assigneeAgentId: "agent-dev" }),
      task({
        id: "lab-5059",
        identifier: "LAB-5059",
        title: "[LAB-4949 · Phase 2 fix] Fix 3 test defects (blocks LAB-5055)",
        parentId: "lab-4949",
        status: "done",
        assigneeAgentId: "agent-tech",
        updatedAt: "2026-10-25T14:18:00Z",
      }),
    ];
    const comments = [
      comment("c-5055", "lab-5055", "3 test defects. [@CTO Backend](agent://agent-cto) Holding my issue blocked pending your call: fix the tests and I'll re-verify.", { agent: "agent-dev" }, "2026-10-25T14:05:00Z"),
      comment("c-5059", "lab-5059", "Phase 2 fix COMPLETE. Handing back to Backend Dev Specialist (LAB-5055) for final GREEN confirmation.", { agent: "agent-tech" }, "2026-10-25T14:18:00Z"),
    ];
    return { tasks, comments };
  }

  async function expectResumed(harness: TestHarness) {
    expect(await statusOf(harness, "lab-5055")).toBe("todo");
    const comments = await commentsOn(harness, "lab-5055");
    expect(comments.filter((entry) => entry.body.includes("linear-sync:resume:"))).toHaveLength(1);
    expect(comments.some((entry) => entry.body.includes("linear-sync:handoff:"))).toBe(false);
    const notices = linear.appComments("lin-2103");
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("Reanudada automáticamente");
    expect(notices[0].body).toContain("[LAB-5055](https://paperclip.test/LAB/issues/LAB-5055)");
  }

  it("the sweep links DEV-2103, resumes LAB-5055 and tells Linear, even on the very first pass", async () => {
    const harness = await harnessWith(world());
    await harness.ctx.issues.relations.setBlockedBy("lab-4949", ["lab-5055"], COMPANY);
    await sweep(harness);
    await expectResumed(harness);
  });

  it("events alone give the same result as the sweep", async () => {
    const harness = await harnessWith(world());
    await harness.ctx.issues.relations.setBlockedBy("lab-4949", ["lab-5055"], COMPANY);
    await harness.emit("issue.updated", {}, { companyId: COMPANY, entityId: "lab-5059", entityType: "issue", actorType: "agent" });
    await drainEvents();
    await expectResumed(harness);
  });

  it("a parent waiting for its own subtasks is not announced, and the next passes post nothing new", async () => {
    const harness = await harnessWith(world());
    await harness.ctx.issues.relations.setBlockedBy("lab-4949", ["lab-5055"], COMPANY);
    await sweep(harness);
    await sweep(harness);
    await sweep(harness);
    expect(linear.appComments("lin-2103")).toHaveLength(1);
    expect(linear.find("lin-2103")!.labels).not.toContain("Blocked");
  });
});

describe("N10 and N11 self-healing", () => {
  it("creates the formal relation a still-open fix task announces in its title", async () => {
    linear.addIssue({ id: "lin-7", identifier: "DEV-7" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-7"), status: "in_progress" }),
        task({ id: "b", identifier: "LAB-1", parentId: "root", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: T0 }),
        task({ id: "f", identifier: "LAB-2", title: "Fix (blocks LAB-1)", parentId: "root", status: "in_progress", assigneeAgentId: "agent-tech" }),
      ],
    });
    await sweep(harness);
    const relations = await harness.ctx.issues.relations.get("b", COMPANY);
    expect(relations.blockedBy.map((blocker) => blocker.id)).toEqual(["f"]);
  });

  it("a parent whose formal subtask finished: nothing in Linear, and a silent resume only after the grace period", async () => {
    linear.addIssue({ id: "lin-9", identifier: "DEV-9" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-9"), status: "in_progress" }),
        task({ id: "parent", identifier: "LAB-1", parentId: "root", status: "blocked", assigneeAgentId: "agent-cto", updatedAt: "2026-10-25T17:50:00Z" }),
        task({ id: "sub", identifier: "LAB-2", parentId: "parent", status: "done", assigneeAgentId: "agent-dev", updatedAt: "2026-10-25T17:55:00Z" }),
      ],
    });
    await harness.ctx.issues.relations.setBlockedBy("parent", ["sub"], COMPANY);
    await sweep(harness); // baseline
    await sweep(harness);
    expect(await statusOf(harness, "parent")).toBe("blocked");

    at("2026-10-25T18:30:00Z");
    await sweep(harness);
    expect(await statusOf(harness, "parent")).toBe("todo");
    expect((await commentsOn(harness, "parent")).some((entry) => entry.body.includes("linear-sync:resume:"))).toBe(true);
    expect(linear.appComments("lin-9")).toEqual([]);
  });

  it("re-mentions an agent named in plain text and wakes its blocked task", async () => {
    linear.addIssue({ id: "lin-8", identifier: "DEV-8" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-8"), status: "in_progress" }),
        task({ id: "b", identifier: "LAB-1", parentId: "root", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: "2026-10-25T17:50:00Z" }),
        task({ id: "f", identifier: "LAB-2", title: "Fix", parentId: "root", status: "done", assigneeAgentId: "agent-tech", updatedAt: "2026-10-25T17:55:00Z" }),
      ],
      comments: [comment("c1", "f", "Done. Handing back to Backend Dev Specialist (LAB-1).", { agent: "agent-tech" }, "2026-10-25T17:55:00Z")],
    });
    await sweep(harness);
    const handoff = (await commentsOn(harness, "b")).find((entry) => entry.body.includes("linear-sync:handoff:"));
    expect(handoff?.body).toContain("[Backend Dev Specialist](agent://agent-dev)");
    expect(await statusOf(harness, "b")).toBe("todo");
    expect(linear.appComments("lin-8")[0].body).toContain("nombrándola sin mencionarla");
  });
});

describe("N3, N4, N17 blocks, unblocks and the Blocked label", () => {
  async function linkedWorld(childLabels: string[] = []) {
    linear.addIssue({ id: "lin-10", identifier: "DEV-10" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-10"), status: "in_progress", assigneeAgentId: "agent-ceo" }),
        task({ id: "child", identifier: "LAB-10", parentId: "root", status: "in_progress", assigneeAgentId: "agent-dev", labels: childLabels }),
      ],
    });
    await sweep(harness); // baseline
    return harness;
  }

  async function block(harness: TestHarness, iso: string) {
    at(iso);
    await harness.ctx.issues.update("child", { status: "blocked" }, COMPANY);
    harness.seed({ issueComments: [comment(`c-${iso}`, "child", "Necesito saber qué formato quiere el cliente.", { agent: "agent-dev" }, iso)] });
  }

  it("announces a new block once with label, and the unblock with label removal", async () => {
    const harness = await linkedWorld();
    await block(harness, "2026-10-25T18:05:00Z");
    await sweep(harness);
    await sweep(harness);
    const afterBlock = linear.appComments("lin-10");
    expect(afterBlock).toHaveLength(1);
    expect(afterBlock[0].body).toContain("Bloqueada en Paperclip");
    expect(afterBlock[0].body).toContain("qué formato quiere el cliente");
    expect(linear.find("lin-10")!.labels).toContain("Blocked");

    await harness.ctx.issues.update("child", { status: "in_progress" }, COMPANY);
    await sweep(harness);
    expect(linear.appComments("lin-10").at(-1)!.body).toContain("Desbloqueada");
    expect(linear.find("lin-10")!.labels).not.toContain("Blocked");
  });

  it("never announces a task waiting for a prototype merge", async () => {
    const harness = await linkedWorld(["awaiting-prototype-merge"]);
    await block(harness, "2026-10-25T18:05:00Z");
    await sweep(harness);
    expect(linear.appComments("lin-10")).toEqual([]);
    expect(linear.find("lin-10")!.labels).not.toContain("Blocked");
  });

  it("N6 mentions the routed person when a human has to answer", async () => {
    const harness = await linkedWorld();
    await block(harness, "2026-10-25T18:05:00Z");
    harness.seed({ issueInteractions: [{ id: "q1", companyId: COMPANY, issueId: "child", kind: "ask_user_questions", status: "pending" } as unknown as IssueThreadInteraction] });
    await sweep(harness);
    expect(linear.appComments("lin-10")[0].body).toContain("https://linear.app/laborai/profiles/jesus");
  });

  it("A: removes a leftover Blocked label once, explaining why, but never on a closed issue", async () => {
    linear.addIssue({ id: "lin-11", identifier: "DEV-11", labels: ["Ready for AI", "Blocked"] });
    linear.addIssue({ id: "lin-12", identifier: "DEV-12", labels: ["Ready for AI", "Blocked"], stateName: "Done" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "r11", description: linearLink("DEV-11"), status: "in_progress" }),
        task({ id: "r12", description: linearLink("DEV-12"), status: "in_progress" }),
      ],
    });
    await sweep(harness); // baseline: nothing touched
    expect(linear.find("lin-11")!.labels).toContain("Blocked");
    await sweep(harness);
    expect(linear.find("lin-11")!.labels).not.toContain("Blocked");
    expect(linear.appComments("lin-11").map((entry) => entry.body).join()).toContain("Era un resto del sistema anterior");
    expect(linear.find("lin-12")!.labels).toContain("Blocked");
    expect(linear.appComments("lin-12")).toEqual([]);
  });

  it("A: a Blocked label a person adds afterwards is never removed", async () => {
    linear.addIssue({ id: "lin-14", identifier: "DEV-14" });
    const harness = await harnessWith({ tasks: [task({ id: "r14", description: linearLink("DEV-14"), status: "in_progress" })] });
    await sweep(harness); // baseline
    await sweep(harness); // one-time check: no label, nothing to clean
    linear.find("lin-14")!.labels.push("Blocked"); // e.g. waiting for the client
    await sweep(harness);
    await sweep(harness);
    expect(linear.find("lin-14")!.labels).toContain("Blocked");
    expect(linear.appComments("lin-14")).toEqual([]);
  });

  it("A: a leftover label that matches a real block is adopted and removed when the block ends", async () => {
    linear.addIssue({ id: "lin-15", identifier: "DEV-15", labels: ["Ready for AI", "Blocked"] });
    const harness = await harnessWith({
      tasks: [
        task({ id: "r15", description: linearLink("DEV-15"), status: "in_progress" }),
        task({ id: "c15", identifier: "LAB-15", parentId: "r15", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: T0 }),
      ],
    });
    await sweep(harness); // baseline
    await sweep(harness); // label adopted: it matches the block
    expect(linear.find("lin-15")!.labels).toContain("Blocked");
    await harness.ctx.issues.update("c15", { status: "in_progress" }, COMPANY);
    await sweep(harness);
    expect(linear.find("lin-15")!.labels).not.toContain("Blocked");
  });

  it("N12 announces a stuck task with nothing blocking it, mentioning the routed person", async () => {
    linear.addIssue({ id: "lin-13", identifier: "DEV-13" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-13"), status: "in_progress" }),
        task({ id: "child", identifier: "LAB-13", parentId: "root", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: "2026-10-25T16:00:00Z" }),
      ],
    });
    await sweep(harness);
    await sweep(harness);
    const notices = linear.appComments("lin-13");
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("Atascada en Paperclip");
    expect(notices[0].body).toContain("https://linear.app/laborai/profiles/jesus");
  });

  it("N5 announces when the work is finished in Paperclip", async () => {
    const harness = await linkedWorld();
    await harness.ctx.issues.update("child", { status: "done" }, COMPANY);
    await harness.ctx.issues.update("root", { status: "done" }, COMPANY);
    await sweep(harness);
    expect(linear.appComments("lin-10").at(-1)!.body).toContain("Terminado en Paperclip");
  });
});

describe("N7, N8 comments both ways", () => {
  async function waitingForHuman() {
    linear.addIssue({ id: "lin-20", identifier: "DEV-20" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-20"), status: "in_progress", assigneeAgentId: "agent-ceo" }),
        task({ id: "child", identifier: "LAB-20", parentId: "root", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: T0 }),
      ],
      interactions: [{ id: "q1", companyId: COMPANY, issueId: "child", kind: "ask_user_questions", status: "pending" } as unknown as IssueThreadInteraction],
    });
    await sweep(harness); // baseline
    return harness;
  }

  const humanComment = (id: string, user: { id: string; name: string; email: string }, iso: string) => {
    linear.find("lin-20")!.comments.push({ id, body: "Usad el formato de la propuesta.", createdAt: iso, parentId: null, user });
  };

  it("relays a human comment to the blocked task as that person, then returns the agent's answer to the thread", async () => {
    const harness = await waitingForHuman();
    at("2026-10-25T18:10:00Z");
    humanComment("lc-1", { id: "u-eros", name: "Eros", email: "eros@x.com" }, "2026-10-25T18:09:00Z");
    await sweep(harness);
    const relayed = (await commentsOn(harness, "child")).find((entry) => entry.body.includes("linear-sync:relay:lc-1"));
    expect(relayed).toMatchObject({ authorUserId: "user-eros" });
    expect(relayed!.body).toContain("Usad el formato de la propuesta.");
    expect(await statusOf(harness, "child")).toBe("todo");

    at("2026-10-25T18:20:00Z");
    harness.seed({ issueComments: [comment("answer", "child", "Hecho: uso el formato de la propuesta.", { agent: "agent-dev" }, "2026-10-25T18:19:00Z")] });
    await sweep(harness);
    await sweep(harness);
    const replies = linear.appComments("lin-20").filter((entry) => entry.body.includes("Respuesta de Backend Dev Specialist"));
    expect(replies).toHaveLength(1);
    expect(replies[0].parentId).toBe("lc-1");
  });

  it("attributes an unknown author to the fallback user and says so", async () => {
    const harness = await waitingForHuman();
    at("2026-10-25T18:10:00Z");
    humanComment("lc-2", { id: "u-x", name: "Alguien", email: "otro@x.com" }, "2026-10-25T18:09:00Z");
    await sweep(harness);
    const relayed = (await commentsOn(harness, "child")).find((entry) => entry.body.includes("linear-sync:relay:lc-2"));
    expect(relayed).toMatchObject({ authorUserId: "user-jesus" });
    expect(relayed!.body).toContain("aquí aparece con otra cuenta");
  });

  it("does not lift a block that waits on another agent: the comment wakes the assignee, the status stays", async () => {
    linear.addIssue({ id: "lin-22", identifier: "DEV-22" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-22"), status: "in_progress", assigneeAgentId: "agent-ceo" }),
        task({ id: "child", identifier: "LAB-22", parentId: "root", status: "blocked", assigneeAgentId: "agent-dev", updatedAt: T0 }),
      ],
      comments: [comment("c1", "child", "Waiting for [CTO Backend](agent://agent-cto) to approve.", { agent: "agent-dev" }, T0)],
    });
    await sweep(harness); // baseline
    at("2026-10-25T18:10:00Z");
    linear.find("lin-22")!.comments.push({ id: "lc-3", body: "Gracias", createdAt: "2026-10-25T18:09:00Z", parentId: null, user: { id: "u-eros", name: "Eros", email: "eros@x.com" } });
    await sweep(harness);
    expect((await commentsOn(harness, "child")).some((entry) => entry.body.includes("linear-sync:relay:lc-3"))).toBe(true);
    expect(await statusOf(harness, "child")).toBe("blocked");
  });

  it("reads past the first 100 Linear comments", async () => {
    const harness = await waitingForHuman();
    const issue = linear.find("lin-20")!;
    for (let index = 0; index < 150; index += 1) {
      issue.comments.push({ id: `bot-${index}`, body: "nota", createdAt: "2026-10-25T17:00:00Z", parentId: null, user: { ...{ id: "app", name: "Paperclip" }, email: null } });
    }
    at("2026-10-25T18:10:00Z");
    humanComment("lc-151", { id: "u-eros", name: "Eros", email: "eros@x.com" }, "2026-10-25T18:09:00Z");
    await sweep(harness);
    expect((await commentsOn(harness, "child")).some((entry) => entry.body.includes("linear-sync:relay:lc-151"))).toBe(true);
  });

  it("does not relay comments that existed before the first pass, nor the app's own", async () => {
    linear.addIssue({ id: "lin-21", identifier: "DEV-21" });
    linear.find("lin-21")!.comments.push({ id: "old", body: "Comentario antiguo", createdAt: "2026-10-20T10:00:00Z", parentId: null, user: { id: "u-eros", name: "Eros", email: "eros@x.com" } });
    const harness = await harnessWith({ tasks: [task({ id: "root", description: linearLink("DEV-21"), status: "in_progress", assigneeAgentId: "agent-ceo" })] });
    await sweep(harness);
    await sweep(harness);
    expect((await commentsOn(harness, "root")).some((entry) => entry.body.includes("linear-sync:relay"))).toBe(false);
  });
});

describe("N13, N14 triggers", () => {
  async function linkedBlocked() {
    linear.addIssue({ id: "lin-30", identifier: "DEV-30" });
    const harness = await harnessWith({
      tasks: [
        task({ id: "root", description: linearLink("DEV-30"), status: "in_progress" }),
        task({ id: "child", identifier: "LAB-30", parentId: "root", status: "in_progress", assigneeAgentId: "agent-dev" }),
      ],
    });
    await sweep(harness); // baseline
    at("2026-10-25T18:05:00Z");
    await harness.ctx.issues.update("child", { status: "blocked" }, COMPANY);
    return harness;
  }

  it("an issue.updated event announces the block without waiting for the sweep", async () => {
    const harness = await linkedBlocked();
    await harness.emit("issue.updated", {}, { companyId: COMPANY, entityId: "child", entityType: "issue", actorType: "agent" });
    await drainEvents();
    expect(linear.appComments("lin-30")[0].body).toContain("Bloqueada en Paperclip");
  });

  it("ignores events caused by the plugin itself", async () => {
    const harness = await linkedBlocked();
    await harness.emit("issue.updated", {}, { companyId: COMPANY, entityId: "child", entityType: "issue", actorType: "plugin" });
    await drainEvents();
    expect(linear.appComments("lin-30")).toEqual([]);
  });

  it("a signed Linear webhook relays a new comment; a bad signature does nothing", async () => {
    linear.addIssue({ id: "lin-31", identifier: "DEV-31" });
    const harness = await harnessWith({ tasks: [task({ id: "root", description: linearLink("DEV-31"), status: "in_progress", assigneeAgentId: "agent-ceo" })] });
    await sweep(harness); // baseline
    at("2026-10-25T18:10:00Z");
    linear.find("lin-31")!.comments.push({ id: "lc-9", body: "¿Cómo va?", createdAt: "2026-10-25T18:09:59Z", parentId: null, user: { id: "u-eros", name: "Eros", email: "eros@x.com" } });
    const rawBody = JSON.stringify({ type: "Comment", action: "create", data: { id: "lc-9", issueId: "lin-31" }, webhookTimestamp: Date.now() });
    const deliver = (signature: string) =>
      plugin.definition.onWebhook!({ endpointKey: LINEAR_WEBHOOK_KEY, headers: { "linear-signature": signature }, rawBody, parsedBody: JSON.parse(rawBody), requestId: "r1" });

    await deliver(createHmac("sha256", "wrong").update(rawBody).digest("hex"));
    await drainEvents();
    expect((await commentsOn(harness, "root")).some((entry) => entry.body.includes("linear-sync:relay:lc-9"))).toBe(false);

    // Linear gives up after 5 s: the delivery only verifies and queues; the pass runs afterwards.
    await deliver(createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex"));
    expect((await commentsOn(harness, "root")).some((entry) => entry.body.includes("linear-sync:relay:lc-9"))).toBe(false);
    await drainEvents();
    expect((await commentsOn(harness, "root")).some((entry) => entry.body.includes("linear-sync:relay:lc-9"))).toBe(true);
  });
});

describe("mentions on issues without a Paperclip task", () => {
  it("answers new ones after the first pass, never the old ones", async () => {
    const issue = linear.addIssue({ id: "lin-40", identifier: "DEV-40" });
    issue.comments.push({ id: "old", body: "@Paperclip antiguo", createdAt: "2026-10-20T10:00:00Z", parentId: null, user: { id: "u1", name: "Eros", email: null } });
    const harness = await harnessWith();
    await sweep(harness);
    expect(linear.appComments("lin-40")).toEqual([]);
    issue.comments.push({ id: "new", body: "@Paperclip ¿hay alguien?", createdAt: "2026-10-25T18:01:00Z", parentId: null, user: { id: "u1", name: "Eros", email: null } });
    await sweep(harness);
    await sweep(harness);
    const replies = linear.appComments("lin-40");
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toContain("todavía no tiene una tarea en Paperclip");
  });
});
