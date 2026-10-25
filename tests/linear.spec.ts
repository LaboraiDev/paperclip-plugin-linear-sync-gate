import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deterministicUuid, verifyLinearSignature, WEBHOOK_MAX_AGE_MS } from "../src/linear.js";

describe("deterministicUuid (same derivation as linear-app-actor.sh)", () => {
  it("is a valid UUID v4 with the RFC 4122 variant, so Linear keeps it instead of minting its own", () => {
    expect(deterministicUuid("block:task-1@2026-10-25T14:05:00Z")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is stable for the same seed and different for another", () => {
    expect(deterministicUuid("a")).toBe(deterministicUuid("a"));
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
  });
});

describe("verifyLinearSignature", () => {
  const secret = "whsec";
  const now = Date.parse("2026-10-25T18:00:00Z");
  const rawBody = JSON.stringify({ type: "Comment", action: "create", webhookTimestamp: now });
  const sign = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");

  it("accepts the HMAC-SHA256 of the raw body within the time window", () => {
    expect(verifyLinearSignature({ rawBody, signature: sign(rawBody), secret, webhookTimestamp: now, nowMs: now + 1_000 })).toBe(true);
  });

  it("rejects a wrong secret, a tampered body or a missing header", () => {
    expect(verifyLinearSignature({ rawBody, signature: sign(rawBody, "other"), secret, webhookTimestamp: now, nowMs: now })).toBe(false);
    expect(verifyLinearSignature({ rawBody: `${rawBody} `, signature: sign(rawBody), secret, webhookTimestamp: now, nowMs: now })).toBe(false);
    expect(verifyLinearSignature({ rawBody, signature: null, secret, webhookTimestamp: now, nowMs: now })).toBe(false);
    expect(verifyLinearSignature({ rawBody, signature: "zz", secret, webhookTimestamp: now, nowMs: now })).toBe(false);
  });

  it("rejects a replay older than the window", () => {
    expect(verifyLinearSignature({ rawBody, signature: sign(rawBody), secret, webhookTimestamp: now, nowMs: now + WEBHOOK_MAX_AGE_MS + 1 })).toBe(false);
  });
});
