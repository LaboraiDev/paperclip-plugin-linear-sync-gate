import { describe, expect, it } from "vitest";
import { blockedDelta, decide, pendingMentions, type LinearComment, type LinearSelf } from "../src/gate.js";

const self: LinearSelf = { id: "app", name: "Paperclip", url: "https://linear.app/laborai/profiles/paperclip" };
const human = { id: "u1", name: "Jesus" };
const app = { id: "app", name: "Paperclip" };
const comment = (id: string, createdAt: string, body: string, user: LinearComment["user"]): LinearComment => ({ id, createdAt, body, user });
const issue = (identifier: string, comments: LinearComment[]) => ({ identifier, comments: { nodes: comments } });

describe("pendingMentions (same rule as linear-app-actor.sh pending-mentions)", () => {
  it("reports a human @-mention the app has not answered", () => {
    const result = pendingMentions([issue("DEV-1", [comment("c1", "2026-10-10T10:00:00Z", "@Paperclip ¿puedes revisar?", human)])], self);
    expect(result).toEqual([{ identifier: "DEV-1", commentId: "c1" }]);
  });

  it("matches the mention case-insensitively and by profile URL", () => {
    const byCase = pendingMentions([issue("DEV-1", [comment("c1", "2026-10-10T10:00:00Z", "hola @paperclip", human)])], self);
    const byUrl = pendingMentions([issue("DEV-2", [comment("c2", "2026-10-10T10:00:00Z", `mira ${self.url}`, human)])], self);
    expect(byCase).toHaveLength(1);
    expect(byUrl).toHaveLength(1);
  });

  it("ignores a mention already answered by a newer app comment", () => {
    const result = pendingMentions(
      [issue("DEV-1", [
        comment("c2", "2026-10-10T11:00:00Z", "Respuesta", app),
        comment("c1", "2026-10-10T10:00:00Z", "@Paperclip pregunta", human),
      ])],
      self,
    );
    expect(result).toEqual([]);
  });

  it("reports the latest mention when a human asks again after the app replied", () => {
    const result = pendingMentions(
      [issue("DEV-1", [
        comment("c1", "2026-10-10T10:00:00Z", "@Paperclip pregunta", human),
        comment("c2", "2026-10-10T11:00:00Z", "Respuesta", app),
        comment("c3", "2026-10-10T12:00:00Z", "@Paperclip otra", human),
      ])],
      self,
    );
    expect(result).toEqual([{ identifier: "DEV-1", commentId: "c3" }]);
  });

  it("never counts the app's own comments as mentions", () => {
    const result = pendingMentions([issue("DEV-1", [comment("c1", "2026-10-10T10:00:00Z", `soy ${self.url}`, app)])], self);
    expect(result).toEqual([]);
  });

  it("counts mentions in comments without a user (bots)", () => {
    const result = pendingMentions([issue("DEV-1", [comment("c1", "2026-10-10T10:00:00Z", "@Paperclip", null)])], self);
    expect(result).toHaveLength(1);
  });
});

describe("blockedDelta", () => {
  const task = (id: string, labelNames: string[] = []) => ({ id, identifier: id, labelNames });

  it("records a baseline on the first check without reporting anything", () => {
    expect(blockedDelta([task("a"), task("b")], null, "awaiting-prototype-merge")).toEqual({ newlyBlocked: [], nextSeen: ["a", "b"] });
  });

  it("reports only tasks that entered blocked since the previous check", () => {
    expect(blockedDelta([task("a"), task("c")], ["a", "b"], "awaiting-prototype-merge")).toEqual({
      newlyBlocked: ["c"],
      nextSeen: ["a", "c"],
    });
  });

  it("excludes tasks waiting for a prototype merge (own label or a blocker's)", () => {
    const delta = blockedDelta([task("a", ["Awaiting-Prototype-Merge"]), task("b")], [], "awaiting-prototype-merge");
    expect(delta).toEqual({ newlyBlocked: ["b"], nextSeen: ["b"] });
  });

  it("reports a task again when the merge label is removed while still blocked", () => {
    expect(blockedDelta([task("a")], [], "awaiting-prototype-merge").newlyBlocked).toEqual(["a"]);
  });
});

describe("decide", () => {
  const idle = { mentions: [], intake: [], newlyBlocked: [] };
  const work = { mentions: [{ identifier: "DEV-1", commentId: "c1" }], intake: [], newlyBlocked: [] };
  const hour = 60 * 60_000;

  it("does not fire when nothing is pending", () => {
    expect(decide(idle, null, 0, hour)).toEqual({ fire: false, reason: "idle" });
  });

  it("fires when something is pending", () => {
    const decision = decide(work, null, 0, hour);
    expect(decision.fire).toBe(true);
    if (decision.fire) expect(decision.items).toEqual(["mention:DEV-1:c1"]);
  });

  it("does not fire the same pending set again within the refire window", () => {
    const first = decide(work, null, 0, hour);
    if (!first.fire) throw new Error("expected fire");
    expect(decide(work, { key: first.key, atMs: 0 }, hour - 1, hour)).toEqual({ fire: false, reason: "recently-fired", key: first.key });
    expect(decide(work, { key: first.key, atMs: 0 }, hour, hour).fire).toBe(true);
  });

  it("fires immediately when the pending set changes", () => {
    const first = decide(work, null, 0, hour);
    if (!first.fire) throw new Error("expected fire");
    const more = { ...work, intake: ["DEV-2"] };
    expect(decide(more, { key: first.key, atMs: 0 }, 1, hour).fire).toBe(true);
  });

  it("produces the same key regardless of item order", () => {
    const a = decide({ mentions: [], intake: ["DEV-1", "DEV-2"], newlyBlocked: [] }, null, 0, hour);
    const b = decide({ mentions: [], intake: ["DEV-2", "DEV-1"], newlyBlocked: [] }, null, 0, hour);
    expect(a.fire && b.fire && a.key === b.key).toBe(true);
  });
});
