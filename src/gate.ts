// Pure mention detection, unchanged from the gate era: the plugin uses it to
// answer mentions of the app on Ready for AI issues that have no Paperclip task.

export interface LinearComment {
  id: string;
  body: string | null;
  createdAt: string;
  user: { id: string; name?: string } | null;
}

export interface LinearIssueWithComments {
  id: string;
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

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
