import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

export const CHECK_JOB_KEY = "check-pending";

const manifest: PaperclipPluginManifestV1 = {
  id: "laboraidev.paperclip-plugin-linear-sync-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear sync gate",
  description:
    "Checks Linear and Paperclip every 5 minutes without an LLM and fires the Linear sync routine only when there is pending work.",
  author: "Laborai",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "issues.read",
    "issue.relations.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: configSchema as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  jobs: [
    {
      jobKey: CHECK_JOB_KEY,
      displayName: "Check Linear and Paperclip for pending work",
      description: "Fires the routine webhook only when a mention, a new Ready for AI issue or a newly blocked task is pending.",
      schedule: "*/5 * * * *",
    },
  ],
};

export default manifest;
