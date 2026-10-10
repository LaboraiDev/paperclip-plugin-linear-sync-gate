import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// No UI: this plugin only runs a scheduled worker job.
const presets = createPluginBundlerPresets();

await Promise.all([esbuild.build(presets.esbuild.worker), esbuild.build(presets.esbuild.manifest)]);
