import fs from "node:fs";
import path from "node:path";
import { DEFAULT_FLEET_SCRIPT, PROMPTS_DIR } from "./paths.js";
import { configExists, ensureConfigDirs, saveRawConfig } from "./config.js";
import { ROLE_PRESETS, rolePreset } from "./presets.js";
import { readText, timestamp, writeText } from "./util.js";

export function parseBashArray(source, name) {
  const match = source.match(new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\)`, "m"));
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const quoted = line.match(/^"([\s\S]*)"$/);
      return quoted ? quoted[1] : null;
    })
    .filter(Boolean);
}

export function parseLegacyScript(source) {
  const agents = parseBashArray(source, "AGENTS").map((line) => {
    const [name, baseUrl, modelId, apiKeyEnv, phase, role, thinking, autoApprove] = line.split("|");
    return { name, baseUrl, modelId, apiKeyEnv, phase, role, thinking, autoApprove };
  });

  const phaseModes = parseBashArray(source, "PHASE_MODES").map((line) => {
    const [name, mode] = line.split("|");
    return { name, mode };
  });

  return { agents, phaseModes };
}

function aliasFrom(agent) {
  const base = agent.modelId
    .replace(/^.*\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "model";
  const key = agent.apiKeyEnv === "NONE" ? "local" : agent.apiKeyEnv.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
  return `${base}-${key}`;
}

function modelMetadata(agent) {
  const lower = agent.modelId.toLowerCase();
  const isQwen = lower.includes("qwen");
  const isGlm = lower.includes("glm");
  return {
    provider: "openai-compatible",
    baseUrl: agent.baseUrl,
    modelId: agent.modelId,
    apiKeyEnv: agent.apiKeyEnv === "NONE" ? null : agent.apiKeyEnv,
    modalities: isQwen ? ["text", "image"] : ["text"],
    contextWindow: isQwen ? 131072 : 65536,
    outputBudget: isGlm ? 6000 : 4000,
    reasoning: agent.thinking || "medium",
    notes: isQwen
      ? "Editable default. Marked multimodal per fleet assumption; doctor verifies endpoint model IDs."
      : "Editable default. Marked text-only per fleet assumption."
  };
}

function rolePresetId(agent) {
  const role = agent.role.toLowerCase();
  if (role.includes("mapper")) return "repo-mapper";
  if (role.includes("skeptic")) return "skeptic";
  if (role.includes("compact") || role.includes("summarizer")) return "compactor";
  if (role.includes("planner") || role.includes("architecture")) return "planner";
  if (role.includes("implementation") || role.includes("coder")) return "coder";
  if (role.includes("security")) return "security-reviewer";
  if (role.includes("test") || role.includes("validation")) return "test-reviewer";
  if (role.includes("reviewer")) return "reviewer";
  if (role.includes("coordinator") || role.includes("decision")) return "coordinator";
  return "custom";
}

function agentPermissions(agent) {
  const preset = rolePreset(rolePresetId(agent));
  if (preset?.permissions) return preset.permissions;
  const write = agent.phase === "implement";
  return {
    mode: write ? "write" : "read-only",
    tools: write ? ["read", "search", "edit", "shell"] : ["read", "search"],
    mcp: "profile"
  };
}

function phaseAgents(agents, phase) {
  return agents.filter((agent) => agent.phase === phase).map((agent) => agent.name);
}

function phaseMode(phaseModes, phase) {
  return phaseModes.find((item) => item.name === phase)?.mode || "sequential";
}

function phaseBlock(agents, phaseModes, name, inputs, options = {}) {
  return {
    name,
    mode: phaseMode(phaseModes, name),
    agents: phaseAgents(agents, name),
    inputs,
    readOnly: options.readOnly ?? name !== "implement",
    compaction: options.compaction || "basic",
    maxInputBytes: options.maxInputBytes || 120000,
    maxOutputWords: options.maxOutputWords || (name === "final" ? 1000 : 2000),
    outputContract: options.outputContract || defaultOutputContract(name)
  };
}

function defaultOutputContract(phase) {
  const contracts = {
    recon: "Concise markdown with relevant files, conventions, commands, risks, and what not to touch.",
    compact: "High-signal context pack preserving exact files, commands, blockers, uncertainty, and next steps.",
    plan: "Implementation plan with assumptions, target files, steps, risks, validation, rollback, and non-goals.",
    implement: "Minimal scoped code changes plus changed files, tests run, and remaining risks.",
    review: "Severity-ranked correctness, regression, security, production, and missing-test findings.",
    final: "Decisive synthesis with must-fix/should-fix issues, safety-to-commit, commands, PR summary, and rollback notes."
  };
  return contracts[phase] || `Complete ${phase} and output concise markdown.`;
}

export function buildConfigFromLegacy({ agents, phaseModes }) {
  const models = {};
  const agentConfigs = [];
  const aliases = new Map();

  for (const agent of agents) {
    const identity = [agent.baseUrl, agent.modelId, agent.apiKeyEnv].join("|");
    if (!aliases.has(identity)) {
      let alias = aliasFrom(agent);
      let suffix = 2;
      while (models[alias]) alias = `${alias}-${suffix++}`;
      aliases.set(identity, alias);
      models[alias] = modelMetadata(agent);
    }

    agentConfigs.push({
      name: agent.name,
      role: agent.role,
      rolePreset: rolePresetId(agent),
      runtime: "cline",
      model: aliases.get(identity),
      profile: agent.name,
      phase: agent.phase,
      prompt: `prompts/${agent.name}.md`,
      thinking: agent.thinking || models[aliases.get(identity)].reasoning,
      autoApprove: String(agent.autoApprove).toLowerCase() === "true",
      permissions: agentPermissions(agent)
    });
  }

  const defaultPhases = [
    phaseBlock(agents, phaseModes, "recon", [], { readOnly: true }),
    phaseBlock(agents, phaseModes, "compact", ["recon"], { readOnly: true }),
    phaseBlock(agents, phaseModes, "plan", ["compact", "recon"], { readOnly: true, maxOutputWords: 2500 }),
    phaseBlock(agents, phaseModes, "review", ["plan", "compact"], { readOnly: true }),
    phaseBlock(agents, phaseModes, "final", ["compact", "plan", "review"], { readOnly: true, maxOutputWords: 1000 })
  ];

  const implementPhases = [
    phaseBlock(agents, phaseModes, "recon", [], { readOnly: true }),
    phaseBlock(agents, phaseModes, "compact", ["recon"], { readOnly: true }),
    phaseBlock(agents, phaseModes, "plan", ["compact", "recon"], { readOnly: true, maxOutputWords: 2500 }),
    phaseBlock(agents, phaseModes, "implement", ["plan"], { readOnly: false, maxOutputWords: 1500 }),
    { name: "capture_diff", type: "diff", inputs: ["implement"] },
    phaseBlock(agents, phaseModes, "review", ["diff", "implement"], { readOnly: true }),
    phaseBlock(agents, phaseModes, "final", ["compact", "plan", "implement", "review"], { readOnly: true, maxOutputWords: 1000 })
  ];

  return {
    models: { models },
    agents: { agents: agentConfigs },
    pipelines: {
      pipelines: {
        default: {
          description: "Safe plan/review pipeline. Does not edit source files.",
          phases: defaultPhases
        },
        implement: {
          description: "Implementation pipeline. Runs code-writing agents before review/final.",
          phases: implementPhases
        }
      }
    }
  };
}

export function buildDefaultConfig() {
  const modelAlias = "local-model";
  const phaseModes = [
    { name: "recon", mode: "parallel" },
    { name: "compact", mode: "sequential" },
    { name: "plan", mode: "sequential" },
    { name: "implement", mode: "sequential" },
    { name: "review", mode: "parallel" },
    { name: "final", mode: "sequential" }
  ];
  const agents = ROLE_PRESETS.map((preset) => ({
    name: preset.id,
    baseUrl: "http://localhost:1234/v1",
    modelId: "local-model-id",
    apiKeyEnv: "NONE",
    phase: preset.phase,
    role: preset.role,
    thinking: preset.thinking,
    autoApprove: String(preset.autoApprove)
  }));
  const generated = buildConfigFromLegacy({ agents, phaseModes });
  generated.models.models = {
    [modelAlias]: {
      provider: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      modelId: "local-model-id",
      apiKeyEnv: null,
      modalities: ["text"],
      contextWindow: 32768,
      outputBudget: 4000,
      reasoning: "medium",
      notes: "Editable starter model. Use Studio model discovery to select an installed local model."
    }
  };
  for (const agent of generated.agents.agents) {
    agent.model = modelAlias;
    agent.profile = agent.name;
  }
  return generated;
}

export function defaultPrompt(agent) {
  return [
    `You are the ${agent.role}.`,
    "",
    "Keep outputs concise and operational.",
    "Prefer exact file paths, symbols, commands, and uncertainty over broad narrative.",
    "Do not dump raw file contents unless the task explicitly requires it.",
    "Stay inside the assigned phase contract."
  ].join("\n");
}

export function initConfig({ source = DEFAULT_FLEET_SCRIPT, force = false } = {}) {
  if (configExists() && !force) {
    throw new Error("Config already exists. Use --force to regenerate it.");
  }

  const legacy = parseLegacyScript(readText(source));

  ensureConfigDirs();
  const generated = legacy.agents.length ? buildConfigFromLegacy(legacy) : buildDefaultConfig();

  if (configExists()) {
    const stamp = timestamp();
    for (const file of ["models.yaml", "agents.yaml", "pipelines.yaml"]) {
      const full = path.join(path.dirname(PROMPTS_DIR), file);
      if (fs.existsSync(full)) fs.copyFileSync(full, `${full}.bak.${stamp}`);
    }
  }

  saveRawConfig(generated);
  for (const agent of generated.agents.agents) {
    const file = path.join(PROMPTS_DIR, `${agent.name}.md`);
    if (!fs.existsSync(file) || force) writeText(file, defaultPrompt(agent));
  }

  return {
    agents: generated.agents.agents.length,
    models: Object.keys(generated.models.models).length,
    pipelines: Object.keys(generated.pipelines.pipelines),
    configDir: path.dirname(PROMPTS_DIR)
  };
}
