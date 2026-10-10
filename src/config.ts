import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export interface GateConfig {
  enabled: boolean;
  /** Agent whose blocked tasks the routine propagates to Linear (Programing CEO). */
  agentId: string;
  /** Public fire URL of the routine's bearer webhook trigger. */
  webhookUrl: string;
  webhookSecret: EnvSecretRefBinding;
  linearClientId: EnvSecretRefBinding;
  linearClientSecret: EnvSecretRefBinding;
  readyLabel: string;
  todoStateName: string;
  awaitingMergeLabel: string;
  refireMinutes: number;
}

export const DEFAULTS = {
  readyLabel: "Ready for AI",
  todoStateName: "Todo",
  awaitingMergeLabel: "awaiting-prototype-merge",
  refireMinutes: 60,
} as const;

const secretRef = (description: string) => ({ type: "object", format: "secret-ref", description });

export const configSchema = {
  type: "object",
  required: ["agentId", "webhookUrl", "webhookSecret", "linearClientId", "linearClientSecret"],
  properties: {
    enabled: { type: "boolean", default: false, description: "Run the check every 5 minutes for this company." },
    agentId: { type: "string", description: "Agent that owns the Linear sync routine (its blocked tasks are watched)." },
    webhookUrl: { type: "string", description: "Fire URL of the routine's bearer webhook trigger." },
    webhookSecret: secretRef("Bearer secret of that webhook trigger."),
    linearClientId: secretRef("LINEAR_CLIENT_ID of the Linear app (same as linear-app-actor)."),
    linearClientSecret: secretRef("LINEAR_CLIENT_SECRET of the Linear app (same as linear-app-actor)."),
    readyLabel: { type: "string", default: DEFAULTS.readyLabel },
    todoStateName: { type: "string", default: DEFAULTS.todoStateName },
    awaitingMergeLabel: { type: "string", default: DEFAULTS.awaitingMergeLabel },
    refireMinutes: { type: "number", minimum: 5, default: DEFAULTS.refireMinutes },
  },
} as const;

/** Returns `skip` when the company has not enabled the gate or the config is incomplete. */
export function parseConfig(raw: Record<string, unknown>): { config: GateConfig } | { skip: string } {
  if (raw.enabled !== true) return { skip: "disabled" };
  const missing = configSchema.required.filter((key) => raw[key] === undefined || raw[key] === null || raw[key] === "");
  if (missing.length > 0) return { skip: `missing config: ${missing.join(", ")}` };
  const text = (key: string, fallback: string) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : fallback);
  return {
    config: {
      enabled: true,
      agentId: raw.agentId as string,
      webhookUrl: raw.webhookUrl as string,
      webhookSecret: raw.webhookSecret as EnvSecretRefBinding,
      linearClientId: raw.linearClientId as EnvSecretRefBinding,
      linearClientSecret: raw.linearClientSecret as EnvSecretRefBinding,
      readyLabel: text("readyLabel", DEFAULTS.readyLabel),
      todoStateName: text("todoStateName", DEFAULTS.todoStateName),
      awaitingMergeLabel: text("awaitingMergeLabel", DEFAULTS.awaitingMergeLabel),
      refireMinutes: typeof raw.refireMinutes === "number" && raw.refireMinutes >= 5 ? raw.refireMinutes : DEFAULTS.refireMinutes,
    },
  };
}
