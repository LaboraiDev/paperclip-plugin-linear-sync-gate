import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

/**
 * `observe` computes and logs every action without writing anywhere;
 * `act` performs them. A new installation always starts in `observe`.
 */
export type SyncMode = "observe" | "act";

/** Who to mention in Linear when a human has to act (emails of Linear users). */
export interface RoutingConfig {
  /** Product/design questions: the blocked task carries `productLabel`. */
  product: string[];
  /** Technical questions, keyed by the Linear issue assignee's email. */
  technicalByAssignee: Record<string, string[]>;
  /** Technical questions when the assignee is anyone else or nobody. */
  technicalDefault: string[];
}

export interface SyncConfig {
  enabled: boolean;
  mode: SyncMode;
  /** Agent that receives new Linear issues (Programing CEO). */
  intakeAgentId: string;
  linearClientId: EnvSecretRefBinding;
  linearClientSecret: EnvSecretRefBinding;
  /** Signing secret of the Linear webhook. Without it webhook deliveries are ignored and only the sweep runs. */
  linearWebhookSecret: EnvSecretRefBinding | null;
  /** Paperclip user that Linear comments are attributed to when the author is not in `userMap`. */
  relayFallbackUserId: string;
  /** Linear user email (lowercase) → Paperclip user id. */
  userMap: Record<string, string>;
  /** Linear label name (lowercase) → Paperclip project id, for intake. */
  projectMap: Record<string, string>;
  /** Paperclip task identifier → Linear issue identifier, for roots whose description has no Linear link. */
  manualLinks: Record<string, string>;
  routing: RoutingConfig;
  /** Base URL of the Paperclip UI, used to link tasks from Linear comments. Empty: no links. */
  paperclipUrl: string;
  readyLabel: string;
  todoStateName: string;
  inProgressStateName: string;
  blockedLabel: string;
  awaitingMergeLabel: string;
  /** Paperclip label that marks a blocked task's question as product/design. */
  productLabel: string;
  /** Minutes without activity after which a blocked task with nothing blocking it counts as stuck. */
  staleMinutes: number;
}

export const DEFAULTS = {
  readyLabel: "Ready for AI",
  todoStateName: "Todo",
  inProgressStateName: "In Progress",
  blockedLabel: "Blocked",
  awaitingMergeLabel: "awaiting-prototype-merge",
  productLabel: "producto",
  staleMinutes: 30,
} as const;

const secretRef = (description: string) => ({ type: "object", format: "secret-ref", description });
const stringMap = (description: string) => ({ type: "object", additionalProperties: { type: "string" }, default: {}, description });
const emailList = { type: "array", items: { type: "string" }, default: [] };

export const configSchema = {
  type: "object",
  required: ["intakeAgentId", "linearClientId", "linearClientSecret", "relayFallbackUserId"],
  properties: {
    enabled: { type: "boolean", default: false, description: "Run the sync for this company." },
    mode: { type: "string", enum: ["observe", "act"], default: "observe", description: "observe: log only. act: write to Linear and Paperclip." },
    intakeAgentId: { type: "string", description: "Agent that receives new Linear issues (Programing CEO)." },
    linearClientId: secretRef("LINEAR_CLIENT_ID of the Linear app (same as linear-app-actor)."),
    linearClientSecret: secretRef("LINEAR_CLIENT_SECRET of the Linear app (same as linear-app-actor)."),
    linearWebhookSecret: secretRef("Signing secret of the Linear webhook. Optional: without it only the 5-minute sweep runs."),
    relayFallbackUserId: { type: "string", description: "Paperclip user that Linear comments are attributed to when the author is not in userMap." },
    userMap: stringMap("Linear user email → Paperclip user id."),
    projectMap: stringMap("Linear label name → Paperclip project id (intake)."),
    manualLinks: stringMap("Paperclip task identifier → Linear issue identifier, for roots without a Linear link in their description."),
    routing: {
      type: "object",
      default: { product: [], technicalByAssignee: {}, technicalDefault: [] },
      properties: {
        product: { ...emailList, description: "Emails to mention for product/design questions." },
        technicalByAssignee: { type: "object", additionalProperties: emailList, default: {}, description: "Linear assignee email → emails to mention." },
        technicalDefault: { ...emailList, description: "Emails to mention when the assignee is anyone else or nobody." },
      },
    },
    paperclipUrl: { type: "string", default: "", description: "Base URL of the Paperclip UI, e.g. https://paperclip.projectllama.cloud" },
    readyLabel: { type: "string", default: DEFAULTS.readyLabel },
    todoStateName: { type: "string", default: DEFAULTS.todoStateName },
    inProgressStateName: { type: "string", default: DEFAULTS.inProgressStateName },
    blockedLabel: { type: "string", default: DEFAULTS.blockedLabel },
    awaitingMergeLabel: { type: "string", default: DEFAULTS.awaitingMergeLabel },
    productLabel: { type: "string", default: DEFAULTS.productLabel },
    staleMinutes: { type: "number", minimum: 5, default: DEFAULTS.staleMinutes },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

const lowerKeys = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));

function parseRouting(value: unknown): RoutingConfig {
  const raw = isRecord(value) ? value : {};
  const byAssignee = isRecord(raw.technicalByAssignee) ? raw.technicalByAssignee : {};
  return {
    product: stringList(raw.product),
    technicalByAssignee: Object.fromEntries(Object.entries(byAssignee).map(([email, list]) => [email.toLowerCase(), stringList(list)])),
    technicalDefault: stringList(raw.technicalDefault),
  };
}

/** Returns `skip` when the company has not enabled the sync or the config is incomplete. */
export function parseConfig(raw: Record<string, unknown>): { config: SyncConfig } | { skip: string } {
  if (raw.enabled !== true) return { skip: "disabled" };
  const missing = configSchema.required.filter((key) => raw[key] === undefined || raw[key] === null || raw[key] === "");
  if (missing.length > 0) return { skip: `missing config: ${missing.join(", ")}` };
  const text = (key: string, fallback: string) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : fallback);
  return {
    config: {
      enabled: true,
      mode: raw.mode === "act" ? "act" : "observe",
      intakeAgentId: raw.intakeAgentId as string,
      linearClientId: raw.linearClientId as EnvSecretRefBinding,
      linearClientSecret: raw.linearClientSecret as EnvSecretRefBinding,
      linearWebhookSecret: (raw.linearWebhookSecret as EnvSecretRefBinding | undefined) ?? null,
      relayFallbackUserId: raw.relayFallbackUserId as string,
      userMap: lowerKeys(stringRecord(raw.userMap)),
      projectMap: lowerKeys(stringRecord(raw.projectMap)),
      manualLinks: stringRecord(raw.manualLinks),
      routing: parseRouting(raw.routing),
      paperclipUrl: text("paperclipUrl", "").replace(/\/+$/, ""),
      readyLabel: text("readyLabel", DEFAULTS.readyLabel),
      todoStateName: text("todoStateName", DEFAULTS.todoStateName),
      inProgressStateName: text("inProgressStateName", DEFAULTS.inProgressStateName),
      blockedLabel: text("blockedLabel", DEFAULTS.blockedLabel),
      awaitingMergeLabel: text("awaitingMergeLabel", DEFAULTS.awaitingMergeLabel),
      productLabel: text("productLabel", DEFAULTS.productLabel),
      staleMinutes: typeof raw.staleMinutes === "number" && raw.staleMinutes >= 5 ? raw.staleMinutes : DEFAULTS.staleMinutes,
    },
  };
}
