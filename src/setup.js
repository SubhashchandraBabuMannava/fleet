import path from "node:path";
import { CONFIG_DIR, PROMPTS_DIR } from "./paths.js";
import { configExists, ensureConfigDirs, saveRawConfig } from "./config.js";

export function buildInitialConfig() {
  return {
    models: { models: {} },
    agents: { agents: [] },
    pipelines: { pipelines: {} }
  };
}

export function initConfig({ force = false } = {}) {
  if (configExists() && !force) {
    throw new Error("Fleet config already exists. Use `fleet studio` to edit it, or `fleet reset --factory --yes` to start over.");
  }

  ensureConfigDirs();
  saveRawConfig(buildInitialConfig());

  return {
    agents: 0,
    models: 0,
    pipelines: [],
    configDir: CONFIG_DIR,
    promptsDir: PROMPTS_DIR,
    next: "Open Fleet Studio with `fleet studio` and complete first-run setup."
  };
}

export function promptForRole(rolePreset) {
  return [
    rolePreset?.prompt || "",
    "",
    "Keep outputs concise and operational.",
    "Prefer exact file paths, symbols, commands, and uncertainty over broad narrative.",
    "Do not dump raw file contents unless the task explicitly requires it."
  ].filter((part) => part.trim()).join("\n");
}

export function promptNameForAgent(agent) {
  const prompt = agent.prompt || `prompts/${agent.name}.md`;
  return path.basename(prompt, ".md");
}
