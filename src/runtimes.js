import fs from "node:fs";
import path from "node:path";
import { buildClineCommand, clineCommandPreview, extractMarkdown, runClineAgent } from "./cline.js";
import { getModel } from "./config.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import { DEFAULT_RUNTIME, RUNTIME_DEFINITIONS, runtimeDefinition } from "./runtime-definitions.js";
import {
  commandExists,
  commandPreview,
  readEnvValue,
  runCapture,
  spawnCollect,
  writeText
} from "./util.js";

export function normalizeRuntime(value) {
  return value || DEFAULT_RUNTIME;
}

export function runtimeMetadata(id) {
  return runtimeDefinition(normalizeRuntime(id));
}

export function runtimeStatuses(config = null) {
  const configuredCustomCommands = new Set();
  for (const agent of config?.agents || []) {
    const command = customCommand(agent);
    if (command) configuredCustomCommands.add(command);
  }

  return Object.values(RUNTIME_DEFINITIONS).map((definition) => {
    const status = {
      ...definition,
      installed: false,
      installDetail: "",
      version: "",
      configuredCommands: [...configuredCustomCommands]
    };

    if (definition.supportsDirectApi) {
      status.installed = true;
      status.installDetail = "No local CLI required.";
      return status;
    }

    if (definition.id === "custom-command") {
      status.installed = configuredCustomCommands.size > 0;
      status.installDetail = status.installed
        ? `${configuredCustomCommands.size} custom command${configuredCustomCommands.size === 1 ? "" : "s"} configured.`
        : "Add runtimeCommand or runtimeConfig.command to an agent.";
      return status;
    }

    status.installed = commandExists(definition.command);
    status.installDetail = status.installed ? `${definition.command} found on PATH.` : `${definition.command} not found on PATH.`;
    if (status.installed) {
      const version = runCapture(definition.command, ["--version"], { timeout: 5000 });
      status.version = (version.stdout || version.stderr || "").trim().split(/\r?\n/)[0] || "available";
    }
    return status;
  });
}

export function runtimeCommandPreview({ config, agent, phase, task, cwd, worktree = false }) {
  const runtime = normalizeRuntime(agent.runtime);
  if (runtime === "cline") return clineCommandPreview({ config, agent, phase, task, cwd, worktree });
  const built = buildRuntimeCommand({ config, agent, phase, task, cwd, worktree, input: "" });
  return commandPreview(built.cmd, redactPreviewArgs(built.args, built.redact || []));
}

export async function runRuntimeAgent(options) {
  const runtime = normalizeRuntime(options.agent.runtime);
  if (runtime === "cline") return runClineAgent(options);
  if (runtime === "openai-compatible-direct") return runDirectAgent(options);
  return runCommandAgent(options);
}

export function runtimeCompatibilityIssues({ config, pipeline, required = ["text"], execution = "dry-run", worktree = false }) {
  const statuses = new Map(runtimeStatuses(config).map((runtime) => [runtime.id, runtime]));
  const issues = [];

  for (const phase of pipeline.phases || []) {
    if (phase.type === "diff") continue;
    for (const agentName of phase.agents || []) {
      const agent = config.agents.find((item) => item.name === agentName);
      if (!agent) continue;
      const runtimeId = normalizeRuntime(agent.runtime);
      const definition = runtimeDefinition(runtimeId);
      const status = statuses.get(runtimeId);
      const model = config.models?.[agent.model];
      const title = `${phase.name}/${agent.name}`;
      const writePhase = phase.readOnly === false || (agent.permissions?.mode || "read-only") === "write";
      const needsMcp = agent.permissions?.mcp && agent.permissions.mcp !== "none";

      if (!definition) {
        issues.push(issue("error", "unknown-runtime", title, `Unknown runtime: ${runtimeId}`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
        continue;
      }

      if (execution === "run" && !status?.installed) {
        issues.push(issue("error", "runtime-not-installed", title, `${definition.label} is not installed or configured.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      } else if (!status?.installed && !definition.supportsDirectApi) {
        issues.push(issue("warn", "runtime-not-installed", title, `${definition.label} is not installed. Dry run can continue, but live runs will fail.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (definition.id === "openai-compatible-direct" && (agent.permissions?.mode || "read-only") !== "read-only") {
        issues.push(issue("error", "direct-runtime-write-role", title, "Direct API workers are allowed only for read-only roles.", { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (writePhase && !definition.supportsWrite) {
        issues.push(issue("error", "runtime-not-write-capable", title, `${definition.label} cannot run write phases.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (needsMcp && !definition.supportsMcp) {
        issues.push(issue("warn", "runtime-no-mcp", title, `${definition.label} does not support MCP/profile tool access.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (worktree && !definition.supportsWorktree) {
        issues.push(issue(writePhase ? "warn" : "info", "runtime-no-worktree", title, `${definition.label} does not manage worktrees; Fleet will run it in the selected project directory.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (required.includes("image") && !definition.supportsMultimodal) {
        issues.push(issue("error", "runtime-not-multimodal", title, `${definition.label} cannot accept image-dependent tasks.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (definition.id === "custom-command" && !customCommand(agent)) {
        issues.push(issue("error", "custom-command-missing", title, "Custom Command runtime needs agent.runtimeCommand or agent.runtimeConfig.command.", { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (definition.maturity === "experimental") {
        issues.push(issue("warn", "runtime-experimental", title, `${definition.label} support is experimental. Keep first runs dry until the command preview looks right.`, { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }

      if (definition.id === "cline" && /qwen-pc/i.test(model?.modelId || "")) {
        issues.push(issue("warn", "cline-qwen-pc-tool-risk", title, "qwen-pc works well as a direct read-only worker, but may not reliably follow Cline tool-call schemas. Prefer Direct API for read-only roles.", { agent: agent.name, phase: phase.name, runtime: runtimeId }));
      }
    }
  }

  return dedupeIssues(issues);
}

export function assertRuntimeCompatibility(options) {
  const issues = runtimeCompatibilityIssues(options);
  const errors = issues.filter((item) => item.level === "error");
  if (errors.length) {
    throw new Error(`Runtime gate failed:\n${errors.map((item) => `${item.title}: ${item.detail}`).join("\n")}`);
  }
  return issues;
}

const DEFAULT_DISCOVERY_ENDPOINTS = [
  { baseUrl: "http://localhost:1234/v1", apiKeyEnv: null }
];

export async function discoverModels(config = null, { endpoints = DEFAULT_DISCOVERY_ENDPOINTS, fetchImpl = fetch } = {}) {
  const groups = new Map();
  for (const [alias, model] of Object.entries(config?.models || {})) {
    const key = `${model.baseUrl || ""}|${model.apiKeyEnv || ""}`;
    const group = groups.get(key) || {
      baseUrl: model.baseUrl,
      apiKeyEnv: model.apiKeyEnv || null,
      aliases: [],
      ok: false,
      ids: [],
      error: ""
    };
    group.aliases.push({ alias, modelId: model.modelId });
    groups.set(key, group);
  }

  for (const endpoint of endpoints) {
    const key = `${endpoint.baseUrl || ""}|${endpoint.apiKeyEnv || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        baseUrl: endpoint.baseUrl,
        apiKeyEnv: endpoint.apiKeyEnv || null,
        aliases: [],
        ok: false,
        ids: [],
        error: ""
      });
    }
  }

  const out = [];
  for (const group of groups.values()) {
    const url = String(group.baseUrl || "").replace(/\/+$/, "") + "/models";
    try {
      const headers = {};
      if (group.apiKeyEnv) {
        const key = readEnvValue(group.apiKeyEnv);
        if (key) headers.Authorization = `Bearer ${key}`;
      }
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      group.ok = true;
      group.ids = extractModelIds(body);
      group.aliases = group.aliases.map((item) => ({
        ...item,
        listed: group.ids.includes(item.modelId),
        suggestion: suggestModelId(item.modelId, group.ids)
      }));
    } catch (error) {
      group.error = `${url}: ${error.message}`;
    }
    out.push(group);
  }
  return out;
}

export function extractModelIds(body) {
  const values = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(values)) return [];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") return item.id || item.name || item.model;
    return null;
  }).filter(Boolean);
}

export function suggestModelId(configured, ids) {
  if (!configured || !ids.length || ids.includes(configured)) return null;
  const exactParent = ids.find((id) => configured.startsWith(`${id}/`));
  if (exactParent) return exactParent;
  const lower = configured.toLowerCase();
  const byContainment = ids.find((id) => lower.includes(id.toLowerCase()) || id.toLowerCase().includes(lower));
  if (byContainment) return byContainment;
  const configuredTail = lower.split("/").filter(Boolean).slice(-2).join("/");
  return ids.find((id) => id.toLowerCase().endsWith(configuredTail)) || null;
}

function buildRuntimeCommand({ config, agent, phase, task, cwd, worktree = false, input = "" }) {
  const runtime = normalizeRuntime(agent.runtime);
  const model = getModel(config, agent.model);
  const system = buildSystemPrompt({ config, agent, phase });
  const prompt = fullPrompt({ task, agent, phase, input });

  if (runtime === "openai-compatible-direct") {
    return {
      cmd: "openai-compatible-direct",
      args: ["POST", model.baseUrl.replace(/\/+$/, "") + "/chat/completions", "--model", model.modelId],
      redact: []
    };
  }

  if (runtime === "claude-code") {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--system-prompt", system,
      "--model", model.modelId,
      "--permission-mode", phase.readOnly === false ? "default" : "plan",
      "--tools", claudeTools(agent, phase),
      "--no-session-persistence",
      "--name", `fleet-${phase.name}-${agent.name}`
    ];
    if (worktree) args.push("--worktree");
    args.push(prompt);
    return { cmd: "claude", args, redact: [system, prompt] };
  }

  if (runtime === "codex") {
    const args = [
      "exec",
      "--cd", cwd,
      "--model", model.modelId,
      "--sandbox", phase.readOnly === false ? "workspace-write" : "read-only",
      "--ask-for-approval", "never",
      promptWithSystem(system, prompt)
    ];
    return { cmd: "codex", args, redact: [promptWithSystem(system, prompt)] };
  }

  if (runtime === "aider") {
    const args = [
      "--model", model.modelId,
      "--message", promptWithSystem(system, prompt),
      "--yes-always",
      "--no-auto-commits",
      "--no-analytics",
      "--no-pretty"
    ];
    if (model.baseUrl) args.push("--openai-api-base", model.baseUrl);
    if (phase.readOnly !== false) args.push("--dry-run");
    return { cmd: "aider", args, redact: [promptWithSystem(system, prompt)] };
  }

  if (runtime === "custom-command") {
    const command = customCommand(agent);
    if (!command) return { cmd: "bash", args: ["-lc", "echo 'missing custom command'"], redact: [] };
    return { cmd: "bash", args: ["-lc", command], redact: [] };
  }

  throw new Error(`Unknown runtime: ${runtime}`);
}

async function runCommandAgent({
  config,
  agent,
  phase,
  task,
  cwd,
  runDir,
  input,
  maxAttempts = 1,
  retrySleepMs = 0,
  worktree = false,
  onOutput = () => {}
}) {
  const built = buildRuntimeCommand({ config, agent, phase, task, cwd, worktree, input });
  const base = `${phase.name}-${agent.name}`;
  const jsonlFile = path.join(runDir, `${base}.jsonl`);
  const mdFile = path.join(runDir, `${base}.md`);
  const promptFile = path.join(runDir, `${base}.prompt.txt`);
  const runtimeId = normalizeRuntime(agent.runtime);
  const prompt = promptWithSystem(
    buildSystemPrompt({ config, agent, phase }),
    fullPrompt({ task, agent, phase, input })
  );
  writeText(promptFile, prompt);

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptFile = path.join(runDir, `${base}.attempt-${attempt}.jsonl`);
    onOutput(`[${phase.name}/${agent.name}/${runtimeId}] attempt ${attempt}/${maxAttempts}\n`);
    const result = await spawnCollect(built.cmd, built.args, {
      cwd,
      input: runtimeId === "custom-command" ? prompt : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv({ config, agent }),
      onStdout: (text) => onOutput(text),
      onStderr: (text) => onOutput(text)
    });
    last = result;
    const raw = `${result.stdout || ""}${result.stderr || ""}`;
    writeText(attemptFile, raw);

    if (result.ok) {
      fs.copyFileSync(attemptFile, jsonlFile);
      writeText(mdFile, extractMarkdown(raw) || raw);
      onOutput(`[${phase.name}/${agent.name}/${runtimeId}] success\n`);
      return { ok: true, jsonlFile, mdFile, status: result.status };
    }

    onOutput(`[${phase.name}/${agent.name}/${runtimeId}] failed with exit ${result.status}\n`);
    if (attempt < maxAttempts && retrySleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retrySleepMs));
    }
  }

  const failure = [
    "# Agent failed",
    "",
    `- Agent: ${agent.name}`,
    `- Runtime: ${runtimeId}`,
    `- Phase: ${phase.name}`,
    `- Attempts: ${maxAttempts}`,
    `- Exit: ${last?.status ?? "unknown"}`,
    "",
    "## Last output",
    "",
    `${last?.stdout || ""}${last?.stderr || ""}`.trim()
  ].join("\n");
  writeText(mdFile, failure);
  writeText(jsonlFile, `${last?.stdout || ""}${last?.stderr || ""}`);
  return { ok: false, jsonlFile, mdFile, status: last?.status ?? -1 };
}

async function runDirectAgent({ config, agent, phase, task, runDir, input, onOutput = () => {} }) {
  if (phase.readOnly === false || (agent.permissions?.mode || "read-only") !== "read-only") {
    throw new Error(`${phase.name}/${agent.name}: Direct API runtime is read-only.`);
  }

  const model = getModel(config, agent.model);
  const base = `${phase.name}-${agent.name}`;
  const jsonlFile = path.join(runDir, `${base}.jsonl`);
  const mdFile = path.join(runDir, `${base}.md`);
  const promptFile = path.join(runDir, `${base}.prompt.txt`);
  const system = buildSystemPrompt({ config, agent, phase });
  const prompt = fullPrompt({ task, agent, phase, input });
  writeText(promptFile, promptWithSystem(system, prompt));

  const headers = { "Content-Type": "application/json" };
  if (model.apiKeyEnv) {
    const key = readEnvValue(model.apiKeyEnv);
    if (!key) throw new Error(`${agent.name}: missing ${model.apiKeyEnv}`);
    headers.Authorization = `Bearer ${key}`;
  }

  const body = {
    model: model.modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: Number(model.outputBudget || phase.maxOutputWords || 2000)
  };

  const url = model.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  onOutput(`[${phase.name}/${agent.name}/openai-compatible-direct] POST ${url}\n`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(agent.timeoutMs || 600000))
  });
  const raw = await res.text();
  writeText(jsonlFile, raw + "\n");
  if (!res.ok) {
    writeText(mdFile, `# Direct API worker failed\n\nHTTP ${res.status}\n\n${raw}\n`);
    return { ok: false, jsonlFile, mdFile, status: res.status };
  }

  const parsed = JSON.parse(raw);
  const text = parsed.choices?.[0]?.message?.content || parsed.output_text || raw;
  writeText(mdFile, text.trim() + "\n");
  onOutput(`[${phase.name}/${agent.name}/openai-compatible-direct] success\n`);
  return { ok: true, jsonlFile, mdFile, status: 0 };
}

function fullPrompt({ task, agent, phase, input = "" }) {
  const base = buildUserPrompt({ task, agent, phase });
  if (!input?.trim()) return base;
  return `${base}\n\nContext from previous phases:\n${input}`;
}

function promptWithSystem(system, prompt) {
  return [`System:\n${system}`, "", `User:\n${prompt}`].join("\n");
}

function redactPreviewArgs(args, redactions) {
  return args.map((arg) => redactions.includes(arg) ? "[prompt]" : arg);
}

function claudeTools(agent, phase) {
  if (phase.readOnly !== false && (agent.permissions?.mode || "read-only") === "read-only") return "Read,Grep,Glob";
  const tools = new Set();
  for (const tool of agent.permissions?.tools || []) {
    if (tool === "read") tools.add("Read");
    if (tool === "search") {
      tools.add("Grep");
      tools.add("Glob");
    }
    if (tool === "edit") {
      tools.add("Edit");
      tools.add("MultiEdit");
      tools.add("Write");
    }
    if (tool === "shell") tools.add("Bash");
  }
  return [...tools].join(",") || "default";
}

function customCommand(agent) {
  return agent.runtimeCommand || agent.runtimeConfig?.command || "";
}

function childEnv({ config, agent }) {
  const model = getModel(config, agent.model);
  const env = { ...process.env };
  env.FLEET_AGENT = agent.name;
  env.FLEET_RUNTIME = normalizeRuntime(agent.runtime);
  env.FLEET_MODEL_ALIAS = agent.model;
  env.FLEET_MODEL_ID = model.modelId;
  env.FLEET_MODEL_BASE_URL = model.baseUrl || "";
  if (model.apiKeyEnv) {
    const key = readEnvValue(model.apiKeyEnv);
    if (key && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = key;
  }
  for (const [key, value] of Object.entries(agent.runtimeConfig?.env || {})) {
    env[key] = String(value);
  }
  return env;
}

function issue(level, code, title, detail, meta = {}) {
  return { level, code, title, detail, ...meta };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = [item.level, item.code, item.title, item.detail].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
