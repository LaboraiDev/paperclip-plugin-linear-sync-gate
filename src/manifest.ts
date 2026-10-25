import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

export const SWEEP_JOB_KEY = "sweep";
export const LINEAR_WEBHOOK_KEY = "linear";

/** Paperclip events that can change what Linear should show. */
export const WATCHED_EVENTS = ["issue.created", "issue.updated", "issue.comment.created", "issue.relations.updated"] as const;

const manifest: PaperclipPluginManifestV1 = {
  // Same id as v0.1.0 so the installation, its config page and its webhook URL stay the same.
  id: "laboraidev.paperclip-plugin-linear-sync-gate",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Linear sync",
  description:
    "Keeps Linear and Paperclip in sync without an LLM: takes in Ready for AI issues, announces blocks and unblocks, relays comments both ways and resumes tasks left waiting.",
  author: "Laborai",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "events.subscribe",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.subtree.read",
    "issue.relations.read",
    "issue.relations.write",
    "issue.comments.read",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
    "issue.interactions.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: configSchema as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Reconcile Linear and Paperclip",
      description: "Safety net for lost events: takes in new issues and reconciles every linked Linear issue.",
      schedule: "*/5 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: LINEAR_WEBHOOK_KEY,
      displayName: "Linear",
      description: "Linear webhook (Issues, Comments, Issue labels). Verified with the Linear-Signature header.",
    },
  ],
};

export default manifest;
