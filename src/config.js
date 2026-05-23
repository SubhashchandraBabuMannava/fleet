import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  CONFIG_DIR,
  MODELS_FILE,
  AGENTS_FILE,
  PIPELINES_FILE,
  PROMPTS_DIR,
  promptPath,
  profileDir
} from "./paths.js";
import { DEFAULT_RUNTIME, RUNTIME_IDS, isKnownRuntime } from "./runtime-definitions.js";
import { ensureDir, readText, writeText, unique } from "./util.js";

export function loadYaml(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const parsed = yaml.load(readText(file));
  return parsed ?? fallback;
}

export function saveYaml(file, value) {
  writeText(file, yaml.dump(value, { lineWidth: 120, noRefs: true, sortKeys: false }));
}

export function configExists() {
  return fs.existsSync(MODELS_FILE) && fs.existsSync(AGENTS_FILE) && fs.existsSync(PIPELINES_FILE);
}

export function ensureConfigDirs() {
  ensureDir(CONFIG_DIR);
  ensureDir(PROMPTS_DIR);
}

export function loadConfig() {
  const modelsDoc = loadYaml(MODELS_FILE, null);
  const agentsDoc = loadYaml(AGENTS_FILE, null);
  const pipelinesDoc = loadYaml(PIPELINES_FILE, null);
  if (!modelsDoc || !agentsDoc || !pipelinesDoc) {
    throw new Error(`Missing fleet config. Run: cline-fleet init`);
  }

  const models = normalizeMap(modelsDoc.models || modelsDoc, "alias");
  const agents = normalizeArray(agentsDoc.agents || agentsDoc);
  const pipelines = normalizeMap(pipelinesDoc.pipelines || pipelinesDoc, "name");

  const config = {
    dir: CONFIG_DIR,
    files: {
      models: MODELS_FILE,
      agents: AGENTS_FILE,
      pipelines: PIPELINES_FILE
    },
    models,
    agents,
    pipelines
  };
  validateConfig(config);
  return config;
}

export function loadRawConfig() {
  return {
    models: loadYaml(MODELS_FILE, { models: {} }),
    agents: loadYaml(AGENTS_FILE, { agents: [] }),
    pipelines: loadYaml(PIPELINES_FILE, { pipelines: {} })
  };
}

export function saveRawConfig(raw) {
  ensureConfigDirs();
  saveYaml(MODELS_FILE, raw.models);
  saveYaml(AGENTS_FILE, raw.agents);
  saveYaml(PIPELINES_FILE, raw.pipelines);
}

export function structuredState() {
  const raw = loadRawConfig();
  const models = Object.entries(raw.models.models || raw.models || {}).map(([alias, model]) => ({ alias, ...model }));
  const pipelines = Object.entries(raw.pipelines.pipelines || raw.pipelines || {}).map(([name, pipeline]) => ({ name, ...pipeline }));
  return {
    configDir: CONFIG_DIR,
    files: {
      models: MODELS_FILE,
      agents: AGENTS_FILE,
      pipelines: PIPELINES_FILE
    },
    raw: {
      models: readText(MODELS_FILE),
      agents: readText(AGENTS_FILE),
      pipelines: readText(PIPELINES_FILE)
    },
    models,
    agents: raw.agents.agents || raw.agents || [],
    pipelines,
    runtimeIds: RUNTIME_IDS
  };
}

export function saveStructuredState(state) {
  const models = {};
  for (const model of state.models || []) {
    const alias = String(model.alias || "").trim();
    if (!alias) throw new Error("Every model needs an alias.");
    const { alias: _alias, ...rest } = model;
    models[alias] = rest;
  }

  const pipelines = {};
  for (const pipeline of state.pipelines || []) {
    const name = String(pipeline.name || "").trim();
    if (!name) throw new Error("Every pipeline needs a name.");
    const { name: _name, ...rest } = pipeline;
    pipelines[name] = rest;
  }

  saveRawConfig({
    models: { models },
    agents: { agents: state.agents || [] },
    pipelines: { pipelines }
  });

  return structuredState();
}

function normalizeMap(value, keyName) {
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (!item?.[keyName]) throw new Error(`Missing ${keyName} in config item`);
      out[item[keyName]] = { ...item };
      delete out[item[keyName]][keyName];
    }
    return out;
  }
  if (!value || typeof value !== "object") return {};
  return value;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) throw new Error("agents config must be a list");
  return value;
}

export function validateConfig(config) {
  const errors = [];
  const agentNames = config.agents.map((a) => a.name);
  const duplicateAgents = agentNames.filter((name, i) => agentNames.indexOf(name) !== i);
  if (duplicateAgents.length) errors.push(`Duplicate agents: ${unique(duplicateAgents).join(", ")}`);

  for (const [alias, model] of Object.entries(config.models)) {
    if (!model.baseUrl) errors.push(`Model ${alias} missing baseUrl`);
    if (!model.modelId) errors.push(`Model ${alias} missing modelId`);
    if (!Array.isArray(model.modalities) || !model.modalities.length) {
      errors.push(`Model ${alias} missing modalities`);
    }
  }

  for (const agent of config.agents) {
    if (!agent.name) errors.push("Agent missing name");
    if (!agent.role) errors.push(`Agent ${agent.name || "(unnamed)"} missing role`);
    if (!agent.model) errors.push(`Agent ${agent.name} missing model`);
    if (agent.model && !config.models[agent.model]) {
      errors.push(`Agent ${agent.name} references unknown model ${agent.model}`);
    }
    if (!agent.runtime) agent.runtime = DEFAULT_RUNTIME;
    if (!isKnownRuntime(agent.runtime)) {
      errors.push(`Agent ${agent.name} references unknown runtime ${agent.runtime}`);
    }
    if (!agent.profile) agent.profile = agent.name;
    if (agent.permissions && !["read-only", "write"].includes(agent.permissions.mode || "read-only")) {
      errors.push(`Agent ${agent.name} permissions.mode must be read-only or write`);
    }
  }

  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    if (!Array.isArray(pipeline.phases)) errors.push(`Pipeline ${name} missing phases`);
    for (const phase of pipeline.phases || []) {
      if (!phase.name) errors.push(`Pipeline ${name} has phase without name`);
      if (phase.type === "diff") continue;
      if (!["parallel", "sequential"].includes(phase.mode)) {
        errors.push(`Pipeline ${name}/${phase.name} mode must be parallel or sequential`);
      }
      if (phase.maxInputBytes !== undefined && Number(phase.maxInputBytes) <= 0) {
        errors.push(`Pipeline ${name}/${phase.name} maxInputBytes must be positive`);
      }
      if (phase.maxOutputWords !== undefined && Number(phase.maxOutputWords) <= 0) {
        errors.push(`Pipeline ${name}/${phase.name} maxOutputWords must be positive`);
      }
      for (const agentName of phase.agents || []) {
        if (!agentNames.includes(agentName)) {
          errors.push(`Pipeline ${name}/${phase.name} references unknown agent ${agentName}`);
        }
      }
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
}

export function getAgent(config, name) {
  const agent = config.agents.find((a) => a.name === name);
  if (!agent) throw new Error(`Unknown agent: ${name}`);
  return agent;
}

export function getModel(config, alias) {
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown model: ${alias}`);
  return model;
}

export function agentPromptPath(agent) {
  if (!agent.prompt) return promptPath(`${agent.name}.md`);
  return promptPath(agent.prompt);
}

export function agentProfileDir(agent) {
  return profileDir(agent.profile || agent.name);
}

export function promptsList() {
  ensureDir(PROMPTS_DIR);
  return fs.readdirSync(PROMPTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      name: name.replace(/\.md$/, ""),
      file: path.join(PROMPTS_DIR, name),
      content: readText(path.join(PROMPTS_DIR, name))
    }));
}
