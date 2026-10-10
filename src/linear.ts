// Thin Linear adapter. Queries and token request mirror
// `linear-app-actor.sh` (the skill the routine itself uses), so the gate sees
// exactly what the routine will see.
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

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class LinearError extends Error {}

export interface LinearSession {
  self(): Promise<LinearSelf>;
  issuesWithComments(readyLabel: string): Promise<LinearIssueWithComments[]>;
  todoIdentifiers(todoStateName: string, readyLabel: string): Promise<string[]>;
}

/**
 * Mint a client_credentials token, run `work`, and always revoke the token,
 * so the gate never holds a credential between checks and never adds to
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

function createSession(fetch: Fetch, token: string): LinearSession {
  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json().catch(() => null)) as { data?: T; errors?: Array<{ message?: string }> } | null;
    if (!response.ok || !payload || payload.errors?.length || payload.data === undefined) {
      const detail = payload?.errors?.map((error) => error.message).join("; ") ?? "";
      throw new LinearError(`Linear GraphQL failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return payload.data;
  }

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
    async todoIdentifiers(todoStateName, readyLabel) {
      const filter = { state: { name: { eq: todoStateName } }, labels: { name: { eq: readyLabel } } };
      const data = await gql<{ issues: { nodes: Array<{ identifier: string }> } }>(
        "query($f: IssueFilter) { issues(filter: $f, first: 50) { nodes { id identifier } } }",
        { f: filter },
      );
      return data.issues.nodes.map((issue) => issue.identifier);
    },
  };
}
