// Thin Linear adapter. Token request, queries and mutations mirror
// `linear-app-actor.sh` (the skill the agents use), so the plugin and the
// agents see and write exactly the same things.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { LinearIssueWithComments, LinearSelf } from "./gate.js";

export const LINEAR_OAUTH_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Must stay identical to the scopes `linear-app-actor.sh` requests: asking for
 * a different scope set makes Linear revoke every existing app token,
 * including the one the agent is using mid-run.
 */
export const LINEAR_APP_SCOPE = "read write app:mentionable";

/** Linear rejects webhooks older than this in its own reference implementation. */
export const WEBHOOK_MAX_AGE_MS = 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class LinearError extends Error {}

export interface LinearUser {
  id: string;
  name?: string;
  email?: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  labels: { nodes: Array<{ id: string; name: string }> };
  assignee: { email: string | null; name: string } | null;
  team: { id: string };
}

export interface LinearIssueComment {
  id: string;
  body: string | null;
  createdAt: string;
  parent: { id: string } | null;
  user: LinearUser | null;
}

export interface LinearSession {
  self(): Promise<LinearSelf>;
  issuesWithComments(readyLabel: string): Promise<LinearIssueWithComments[]>;
  todoIssues(todoStateName: string, readyLabel: string): Promise<LinearIssue[]>;
  /** Accepts the UUID or the identifier (DEV-123). */
  issue(id: string): Promise<LinearIssue | null>;
  issueComments(issueId: string): Promise<LinearIssueComment[]>;
  userUrlByEmail(email: string): Promise<string | null>;
  labelId(name: string): Promise<string | null>;
  /** Idempotent: the same `id` posted twice is reported as already existing, never duplicated. */
  createComment(input: { id: string; issueId: string; body: string; parentId?: string | null }): Promise<{ alreadyExisted: boolean }>;
  updateLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void>;
  setState(issueId: string, teamId: string, stateName: string): Promise<void>;
  /** GraphQL calls made in this session (Linear allows 5,000/hour for an OAuth app). */
  calls(): number;
}

/** Comments are paged through to the end: Linear's docs do not say which 100 come first. */
const MAX_COMMENT_PAGES = 10;

/**
 * Mint a client_credentials token, run `work`, and always revoke the token,
 * so the plugin never holds a credential between passes and never adds to
 * Linear's limit of active app tokens.
 */
export async function withLinearSession<T>(
  fetch: Fetch,
  credentials: { clientId: string; clientSecret: string },
  work: (session: LinearSession) => Promise<T>,
): Promise<T> {
  const token = await mintToken(fetch, credentials);
  try {
    return await work(createSession(fetch, token));
  } finally {
    await revokeToken(fetch, token).catch(() => undefined);
  }
}

/**
 * Same derivation as `deterministic_uuid` in `linear-app-actor.sh`: a valid
 * UUID v4 from a seed, so retrying `commentCreate` with the same seed reuses
 * the id and Linear rejects it as a conflict instead of posting a duplicate.
 * The version and variant nibbles must be forced: Linear silently replaces a
 * malformed id with its own, which defeats the conflict.
 */
export function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const variant = ((parseInt(hash[15], 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-${variant}${hash.slice(16, 19)}-${hash.slice(19, 31)}`;
}

/**
 * Linear signs the raw body with HMAC-SHA256 (hex, `Linear-Signature` header)
 * and puts the send time in `webhookTimestamp` (ms). Both must hold.
 */
export function verifyLinearSignature(input: {
  rawBody: string;
  signature: string | null;
  secret: string;
  webhookTimestamp: unknown;
  nowMs: number;
}): boolean {
  if (!input.signature || !/^[0-9a-f]+$/i.test(input.signature)) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const received = Buffer.from(input.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  return typeof input.webhookTimestamp === "number" && Math.abs(input.nowMs - input.webhookTimestamp) <= WEBHOOK_MAX_AGE_MS;
}

async function mintToken(fetch: Fetch, credentials: { clientId: string; clientSecret: string }): Promise<string> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetch(LINEAR_OAUTH_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: LINEAR_APP_SCOPE }).toString(),
  });
  const payload = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new LinearError(`Linear token request failed with HTTP ${response.status}`);
  }
  return payload.access_token;
}

async function revokeToken(fetch: Fetch, token: string): Promise<void> {
  await fetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
  });
}

const ISSUE_FIELDS = "id identifier url title description state { name type } labels { nodes { id name } } assignee { email name } team { id }";

function createSession(fetch: Fetch, token: string): LinearSession {
  type GqlErrors = Array<{ message?: string; extensions?: { userPresentableMessage?: string } }>;

  let callCount = 0;

  async function request<T>(query: string, variables: Record<string, unknown>): Promise<{ status: number; ok: boolean; data?: T; errors?: GqlErrors }> {
    callCount += 1;
    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json().catch(() => null)) as { data?: T; errors?: GqlErrors } | null;
    return { status: response.status, ok: response.ok, data: payload?.data, errors: payload?.errors };
  }

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const result = await request<T>(query, variables);
    if (!result.ok || result.errors?.length || result.data === undefined) {
      const detail = result.errors?.map((error) => error.message).join("; ") ?? "";
      throw new LinearError(`Linear GraphQL failed with HTTP ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return result.data;
  }

  const labelIds = new Map<string, string | null>();

  return {
    async self() {
      const data = await gql<{ viewer: LinearSelf }>("{ viewer { id name url } }");
      return data.viewer;
    },

    // Same filter and selection as `pending-mentions --label <label>`.
    async issuesWithComments(readyLabel) {
      const filter = {
        labels: { name: { eq: readyLabel } },
        or: [
          { state: { type: { eq: "triage" } } },
          { state: { type: { eq: "unstarted" } } },
          { state: { type: { eq: "started" } } },
        ],
      };
      const data = await gql<{ issues: { nodes: LinearIssueWithComments[] } }>(
        "query($f: IssueFilter) { issues(filter: $f, first: 50) { nodes { id identifier url comments(first: 100, orderBy: createdAt) { nodes { id body createdAt user { id name } } pageInfo { hasNextPage } } } } }",
        { f: filter },
      );
      return data.issues.nodes;
    },

    // Same filter as `list --state <state> --label <label>`.
    async todoIssues(todoStateName, readyLabel) {
      const filter = { state: { name: { eq: todoStateName } }, labels: { name: { eq: readyLabel } } };
      const data = await gql<{ issues: { nodes: LinearIssue[] } }>(
        `query($f: IssueFilter) { issues(filter: $f, first: 50) { nodes { ${ISSUE_FIELDS} } } }`,
        { f: filter },
      );
      return data.issues.nodes;
    },

    async issue(id) {
      const result = await request<{ issue: LinearIssue | null }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
      if (result.errors?.some((error) => /not found|entity not found/i.test(error.message ?? ""))) return null;
      if (!result.ok || result.errors?.length || result.data === undefined) {
        throw new LinearError(`Linear GraphQL failed with HTTP ${result.status}`);
      }
      return result.data.issue;
    },

    async issueComments(issueId) {
      type Page = { issue: { comments: { nodes: LinearIssueComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null };
      const comments: LinearIssueComment[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
        const data: Page = await gql<Page>(
          "query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after, orderBy: createdAt) { nodes { id body createdAt parent { id } user { id name email } } pageInfo { hasNextPage endCursor } } } }",
          { id: issueId, after },
        );
        if (!data.issue) break;
        comments.push(...data.issue.comments.nodes);
        if (!data.issue.comments.pageInfo.hasNextPage) break;
        after = data.issue.comments.pageInfo.endCursor;
      }
      return comments;
    },

    // Same lookup as `mention email:<address>`: the profile URL is the mention.
    async userUrlByEmail(email) {
      const data = await gql<{ users: { nodes: Array<{ url: string }> } }>(
        "query($f: UserFilter) { users(filter: $f, first: 1) { nodes { url } } }",
        { f: { email: { eq: email } } },
      );
      return data.users.nodes[0]?.url ?? null;
    },

    // Workspace-wide, like `resolve_label_id`: covers workspace and team labels.
    async labelId(name) {
      if (!labelIds.has(name)) {
        const data = await gql<{ issueLabels: { nodes: Array<{ id: string }> } }>(
          "query($f: IssueLabelFilter) { issueLabels(filter: $f, first: 1) { nodes { id name } } }",
          { f: { name: { eq: name } } },
        );
        labelIds.set(name, data.issueLabels.nodes[0]?.id ?? null);
      }
      return labelIds.get(name) ?? null;
    },

    async createComment({ id, issueId, body, parentId }) {
      const input: Record<string, unknown> = { id, issueId, body };
      if (parentId) input.parentId = parentId;
      const result = await request<{ commentCreate: { success: boolean } }>(
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
        { input },
      );
      const alreadyExists = result.errors?.some((error) =>
        /already exists/i.test(`${error.message ?? ""} ${error.extensions?.userPresentableMessage ?? ""}`),
      );
      if (alreadyExists) return { alreadyExisted: true };
      if (!result.ok || result.errors?.length || !result.data?.commentCreate.success) {
        const detail = result.errors?.map((error) => error.message).join("; ") ?? "";
        throw new LinearError(`Linear commentCreate failed with HTTP ${result.status}${detail ? `: ${detail}` : ""}`);
      }
      return { alreadyExisted: false };
    },

    async updateLabels(issueId, change) {
      const input: Record<string, unknown> = {};
      if (change.add?.length) input.addedLabelIds = change.add;
      if (change.remove?.length) input.removedLabelIds = change.remove;
      if (Object.keys(input).length === 0) return;
      await gql("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issueId, input });
    },

    // Same resolution as `set-status`: state name matched case-insensitively within the issue's team.
    async setState(issueId, teamId, stateName) {
      const data = await gql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
        "query($teamId: String!) { team(id: $teamId) { states { nodes { id name } } } }",
        { teamId },
      );
      const state = data.team.states.nodes.find((node) => node.name.toLowerCase() === stateName.toLowerCase());
      if (!state) throw new LinearError(`No workflow state named '${stateName}' on the issue's team`);
      await gql("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", {
        id: issueId,
        input: { stateId: state.id },
      });
    },

    calls: () => callCount,
  };
}
