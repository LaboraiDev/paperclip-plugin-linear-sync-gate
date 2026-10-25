import { describe, expect, it } from "vitest";
import { pendingMentions, type LinearComment, type LinearSelf } from "../src/gate.js";

const self: LinearSelf = { id: "app", name: "Paperclip", url: "https://linear.app/laborai/profiles/paperclip" };
const human = { id: "u1", name: "Jesus" };
const app = { id: "app", name: "Paperclip" };
const comment = (id: string, createdAt: string, body: string, user: LinearComment["user"]): LinearComment => ({ id, createdAt, body, user });
const issue = (identifier: string, comments: LinearComment[]) => ({ id: `id-${identifier}`, identifier, comments: { nodes: comments } });

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
