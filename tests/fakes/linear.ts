// In-memory Linear that answers the exact queries and mutations `src/linear.ts`
// sends, so harness tests can assert on what ended up in Linear.
import { LINEAR_GRAPHQL_URL, LINEAR_OAUTH_URL, LINEAR_REVOKE_URL } from "../../src/linear.js";

export interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  user: { id: string; name: string; email: string | null } | null;
}

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  stateName: string;
  labels: string[];
  assigneeEmail: string | null;
  comments: FakeComment[];
}

const STATES = [
  { id: "st-todo", name: "Todo", type: "unstarted" },
  { id: "st-progress", name: "In Progress", type: "started" },
  { id: "st-done", name: "Done", type: "completed" },
  { id: "st-duplicate", name: "Duplicate", type: "canceled" },
];

export const APP = { id: "app", name: "Paperclip", url: "https://linear.app/laborai/profiles/paperclip" };

export class FakeLinear {
  readonly issues = new Map<string, FakeIssue>();
  readonly labels = new Map([
    ["Blocked", "label-blocked"],
    ["Ready for AI", "label-ready"],
    ["Backend", "label-backend"],
    ["Frontend", "label-frontend"],
  ]);
  readonly users = new Map<string, string>();
  readonly tokenBodies: string[] = [];
  readonly mutations: string[] = [];
  revoked = 0;
  tokenStatus: number | null = null;

  addIssue(issue: Partial<FakeIssue> & Pick<FakeIssue, "id" | "identifier">): FakeIssue {
    const full: FakeIssue = { title: issue.identifier, description: null, stateName: "In Progress", labels: ["Ready for AI"], assigneeEmail: null, comments: [], ...issue };
    this.issues.set(full.id, full);
    return full;
  }

  url(issue: FakeIssue) {
    return `https://linear.app/laborai/issue/${issue.identifier}/x`;
  }

  find(id: string): FakeIssue | undefined {
    return this.issues.get(id) ?? [...this.issues.values()].find((issue) => issue.identifier === id);
  }

  /** Comments the app wrote, in order. */
  appComments(id: string): FakeComment[] {
    return (this.find(id)?.comments ?? []).filter((comment) => comment.user?.id === APP.id);
  }

  private view(issue: FakeIssue) {
    const state = STATES.find((candidate) => candidate.name === issue.stateName)!;
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: this.url(issue),
      title: issue.title,
      description: issue.description,
      state: { name: state.name, type: state.type },
      labels: { nodes: issue.labels.map((name) => ({ id: this.labels.get(name) ?? name, name })) },
      assignee: issue.assigneeEmail ? { email: issue.assigneeEmail, name: issue.assigneeEmail } : null,
      team: { id: "team-dev" },
    };
  }

  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const body = typeof init.body === "string" ? init.body : "";
    if (url === LINEAR_OAUTH_URL) {
      this.tokenBodies.push(body);
      return this.tokenStatus ? json(this.tokenStatus, {}) : json(200, { access_token: "lin-token" });
    }
    if (url === LINEAR_REVOKE_URL) {
      this.revoked += 1;
      return json(200, {});
    }
    if (url !== LINEAR_GRAPHQL_URL) throw new Error(`unexpected fetch ${url}`);
    const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, any> };

    if (query.includes("viewer")) return json(200, { data: { viewer: APP } });
    if (query.includes("issueLabels")) {
      const id = this.labels.get(variables.f.name.eq);
      return json(200, { data: { issueLabels: { nodes: id ? [{ id, name: variables.f.name.eq }] : [] } } });
    }
    if (query.includes("users(filter")) {
      const found = this.users.get(variables.f.email.eq);
      return json(200, { data: { users: { nodes: found ? [{ url: found }] : [] } } });
    }
    if (query.includes("team(id:")) return json(200, { data: { team: { states: { nodes: STATES.map(({ id, name }) => ({ id, name })) } } } });
    if (query.includes("commentCreate")) {
      this.mutations.push("commentCreate");
      const input = variables.input as { id: string; issueId: string; body: string; parentId?: string };
      const exists = [...this.issues.values()].some((issue) => issue.comments.some((comment) => comment.id === input.id));
      if (exists) return json(200, { errors: [{ message: "conflict on insert of Comment", extensions: { userPresentableMessage: `Entity Comment with id ${input.id} already exists.` } }] });
      const issue = this.find(input.issueId);
      if (!issue) return json(200, { errors: [{ message: "Entity not found" }] });
      issue.comments.push({ id: input.id, body: input.body, createdAt: new Date().toISOString(), parentId: input.parentId ?? null, user: { ...APP, email: null } });
      return json(200, { data: { commentCreate: { success: true, comment: { id: input.id } } } });
    }
    if (query.includes("issueUpdate")) {
      this.mutations.push("issueUpdate");
      const issue = this.find(variables.id)!;
      const input = variables.input as { addedLabelIds?: string[]; removedLabelIds?: string[]; stateId?: string };
      const nameOf = (labelId: string) => [...this.labels].find(([, id]) => id === labelId)?.[0] ?? labelId;
      for (const id of input.addedLabelIds ?? []) if (!issue.labels.includes(nameOf(id))) issue.labels.push(nameOf(id));
      issue.labels = issue.labels.filter((name) => !(input.removedLabelIds ?? []).map(nameOf).includes(name));
      if (input.stateId) issue.stateName = STATES.find((state) => state.id === input.stateId)!.name;
      return json(200, { data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issue(id: $id) { comments")) {
      const issue = this.find(variables.id);
      const nodes = (issue?.comments ?? [])
        .map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, parent: comment.parentId ? { id: comment.parentId } : null, user: comment.user }));
      return json(200, { data: { issue: issue ? { comments: { nodes } } : null } });
    }
    if (query.includes("issue(id: $id)")) {
      const issue = this.find(variables.id);
      return issue ? json(200, { data: { issue: this.view(issue) } }) : json(200, { errors: [{ message: "Entity not found: Issue" }], data: { issue: null } });
    }
    if (query.includes("issues(filter") && query.includes("comments")) {
      const types = (variables.f.or as Array<{ state: { type: { eq: string } } }>).map((entry) => entry.state.type.eq);
      const nodes = [...this.issues.values()]
        .filter((issue) => issue.labels.includes(variables.f.labels.name.eq) && types.includes(STATES.find((state) => state.name === issue.stateName)!.type))
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          url: this.url(issue),
          comments: { nodes: issue.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, user: comment.user })), pageInfo: { hasNextPage: false } },
        }));
      return json(200, { data: { issues: { nodes } } });
    }
    if (query.includes("issues(filter")) {
      const nodes = [...this.issues.values()]
        .filter((issue) => issue.stateName === variables.f.state.name.eq && issue.labels.includes(variables.f.labels.name.eq))
        .map((issue) => this.view(issue));
      return json(200, { data: { issues: { nodes } } });
    }
    throw new Error(`fake Linear does not handle: ${query}`);
  }
}
