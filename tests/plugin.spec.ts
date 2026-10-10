import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company, Issue } from "@paperclipai/plugin-sdk";
import manifest, { CHECK_JOB_KEY } from "../src/manifest.js";
import plugin from "../src/worker.js";
import { LINEAR_APP_SCOPE, LINEAR_GRAPHQL_URL, LINEAR_OAUTH_URL, LINEAR_REVOKE_URL } from "../src/linear.js";

const COMPANY = "company-1";
const AGENT = "agent-ceo";
const WEBHOOK = "https://paperclip.test/api/routine-triggers/public/abc/fire";
const ref = (secretId: string) => ({ type: "secret_ref", secretId });
const config = {
  enabled: true,
  agentId: AGENT,
  webhookUrl: WEBHOOK,
  webhookSecret: ref("webhook"),
  linearClientId: ref("client-id"),
  linearClientSecret: ref("client-secret"),
};
const self = { id: "app", name: "Paperclip", url: "https://linear.app/laborai/profiles/paperclip" };

interface LinearFixture {
  mentionIssues: Array<{ identifier: string; comments: { nodes: unknown[] } }>;
  todo: string[];
  tokenStatus?: number;
}

interface Calls {
  tokenBodies: string[];
  revoked: number;
  webhook: Array<{ headers: Record<string, string>; body: { items: string[] } }>;
}

function stubFetch(linear: LinearFixture, webhookResponse: () => { status: number; body: unknown }): Calls {
  const calls: Calls = { tokenBodies: [], revoked: 0, webhook: [] };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    if (url === LINEAR_OAUTH_URL) {
      calls.tokenBodies.push(body);
      return linear.tokenStatus ? json(linear.tokenStatus, {}) : json(200, { access_token: "lin-token" });
    }
    if (url === LINEAR_REVOKE_URL) {
      calls.revoked += 1;
      return json(200, {});
    }
    if (url === LINEAR_GRAPHQL_URL) {
      const { query } = JSON.parse(body) as { query: string };
      if (query.includes("viewer")) return json(200, { data: { viewer: self } });
      if (query.includes("comments")) return json(200, { data: { issues: { nodes: linear.mentionIssues } } });
      return json(200, { data: { issues: { nodes: linear.todo.map((identifier) => ({ id: identifier, identifier })) } } });
    }
    if (url === WEBHOOK) {
      calls.webhook.push({ headers: init.headers as Record<string, string>, body: JSON.parse(body) });
      const response = webhookResponse();
      return json(response.status, response.body);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const blockedIssue = (id: string, labels: string[] = [], status = "blocked") =>
  ({
    id,
    companyId: COMPANY,
    identifier: id.toUpperCase(),
    title: id,
    status,
    assigneeAgentId: AGENT,
    labels: labels.map((name) => ({ id: name, companyId: COMPANY, name })),
  }) as unknown as Issue;

async function harnessWith(issues: Issue[] = []): Promise<TestHarness> {
  // `issue.relations.write` only lets the test wire blockers; the plugin never writes.
  const harness = createTestHarness({ manifest, config, capabilities: [...manifest.capabilities, "issue.relations.write"] });
  harness.seed({ companies: [{ id: COMPANY, name: "Laborai" } as unknown as Company], issues });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

// Shape returned by the 2026.1005.0 public fire route: the routine run row itself.
const accepted = () => ({ status: 202, body: { id: "run-1", status: "issue_created" } });
const mention = { identifier: "DEV-1", comments: { nodes: [{ id: "c1", body: "@Paperclip ¿?", createdAt: "2026-10-10T10:00:00Z", user: { id: "u1" } }] } };

describe("linear sync gate job", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it("declares the scheduled job and only the capabilities it uses", () => {
    expect(manifest.jobs).toEqual([expect.objectContaining({ jobKey: CHECK_JOB_KEY, schedule: "*/5 * * * *" })]);
    expect(manifest.capabilities).not.toContain("issues.update");
  });

  it("does not fire when Linear and Paperclip have nothing pending", async () => {
    const calls = stubFetch({ mentionIssues: [], todo: [] }, accepted);
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(0);
  });

  it("requests the token with the exact scopes of linear-app-actor.sh and always revokes it", async () => {
    const calls = stubFetch({ mentionIssues: [], todo: [] }, accepted);
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    const params = new URLSearchParams(calls.tokenBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe(LINEAR_APP_SCOPE);
    expect(calls.revoked).toBe(1);
  });

  it("fires the webhook with a bearer secret when a mention is pending", async () => {
    const calls = stubFetch({ mentionIssues: [mention], todo: [] }, accepted);
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY, { scheduledAt: "2026-10-10T10:05:00Z" });
    expect(calls.webhook).toHaveLength(1);
    expect(calls.webhook[0].headers.Authorization).toBe(`Bearer resolved:${String(config.webhookSecret)}`);
    expect(calls.webhook[0].headers["Idempotency-Key"]).toMatch(/-2026-10-10T10:05:00Z$/);
    expect(calls.webhook[0].body.items).toEqual(["mention:DEV-1:c1"]);
  });

  it("does not fire the same pending set again on the next check", async () => {
    const calls = stubFetch({ mentionIssues: [mention], todo: ["DEV-2"] }, accepted);
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(1);
  });

  it.each(["coalesced", "skipped", "failed"])("retries on the next check when the run status is %s", async (first) => {
    let status = first;
    const calls = stubFetch({ mentionIssues: [], todo: ["DEV-2"] }, () => ({ status: 202, body: { id: "run-1", status } }));
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    status = "issue_created";
    await harness.runJob(CHECK_JOB_KEY);
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(2);
  });

  it("retries on the next check when the webhook answers an HTTP error (e.g. 409 paused routine)", async () => {
    let status = 409;
    const calls = stubFetch({ mentionIssues: [], todo: ["DEV-2"] }, () => ({ status, body: { error: "Routine trigger is not active" } }));
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    status = 202;
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(2);
  });

  it("treats setup-mode test receipts as delivered (observation phase)", async () => {
    const calls = stubFetch({ mentionIssues: [], todo: ["DEV-2"] }, () => ({ status: 202, body: { status: "test_received", test: true } }));
    const harness = await harnessWith();
    await harness.runJob(CHECK_JOB_KEY);
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(1);
    expect(harness.logs.some((log) => log.meta?.outcome === "test_received")).toBe(true);
  });

  it("fires for a task that becomes blocked after the baseline, but not for one awaiting a prototype merge", async () => {
    const calls = stubFetch({ mentionIssues: [], todo: [] }, accepted);
    const harness = await harnessWith([blockedIssue("old")]);
    await harness.runJob(CHECK_JOB_KEY); // baseline
    harness.seed({ issues: [blockedIssue("merge-wait", ["awaiting-prototype-merge"]), blockedIssue("new")] });
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(1);
    expect(calls.webhook[0].body.items).toEqual(["blocked:new"]);
  });

  it("excludes a blocked task whose direct blocker is waiting for a prototype merge", async () => {
    const calls = stubFetch({ mentionIssues: [], todo: [] }, accepted);
    const harness = await harnessWith([]);
    await harness.runJob(CHECK_JOB_KEY); // baseline (empty)
    harness.seed({ issues: [blockedIssue("parent"), blockedIssue("prototype-pr", ["awaiting-prototype-merge"], "in_review")] });
    await harness.ctx.issues.relations.setBlockedBy("parent", ["prototype-pr"], COMPANY);
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.webhook).toHaveLength(0);
  });

  it("does nothing for a company that has not enabled the gate", async () => {
    const calls = stubFetch({ mentionIssues: [mention], todo: [] }, accepted);
    const harness = await harnessWith();
    harness.setConfig({ ...config, enabled: false });
    await harness.runJob(CHECK_JOB_KEY);
    expect(calls.tokenBodies).toHaveLength(0);
    expect(calls.webhook).toHaveLength(0);
  });

  it("fails the job without firing when Linear rejects the token request", async () => {
    const calls = stubFetch({ mentionIssues: [mention], todo: [], tokenStatus: 401 }, accepted);
    const harness = await harnessWith();
    await expect(harness.runJob(CHECK_JOB_KEY)).rejects.toThrow(/HTTP 401/);
    expect(calls.webhook).toHaveLength(0);
  });
});
