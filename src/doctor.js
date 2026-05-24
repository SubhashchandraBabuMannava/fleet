import fs from "node:fs";
import path from "node:path";
import { hasRunnableConfig, loadConfig, agentProfileDir, getModel } from "./config.js";
import { ENV_FILE } from "./paths.js";
import { extractModelIds, normalizeRuntime, runtimeStatuses } from "./runtimes.js";
import { readEnvValue } from "./util.js";

export async function doctor() {
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    checks: []
  };
  const add = (level, title, detail = "") => {
    if (["error", "warn"].includes(level)) report.ok = false;
    report.checks.push({ level, title, detail });
  };

  let config;
  try {
    config = loadConfig();
    add("ok", "config", `Loaded ${config.agents.length} agents, ${Object.keys(config.models).length} models.`);
  } catch (error) {
    add("error", "setup", error.message);
    addRuntimeChecks(null, add);
    return report;
  }

  if (!hasRunnableConfig(config)) {
    add("error", "setup", "Add at least one model, one agent, and one workflow in Fleet Studio.");
  }

  addRuntimeChecks(config, add);

  for (const agent of config.agents) {
    if (normalizeRuntime(agent.runtime) !== "cline") continue;
    const dir = agentProfileDir(agent);
    const providers = path.join(dir, "data", "settings", "providers.json");
    if (!fs.existsSync(dir)) {
      add("error", `profile:${agent.name}`, `Missing profile dir: ${dir}`);
      continue;
    }
    if (!fs.existsSync(providers)) {
      add("warn", `profile:${agent.name}`, `Missing provider settings: ${providers}`);
      continue;
    }
    compareProviderSettings(agent, getModel(config, agent.model), providers, add);
  }

  for (const [alias, model] of Object.entries(config.models)) {
    await checkModelEndpoint(alias, model, add);
  }

  return report;
}

function addRuntimeChecks(config, add) {
  const runtimes = runtimeStatuses(config);
  for (const runtime of runtimes) {
    if (runtime.installed) {
      add("ok", `runtime:${runtime.id}`, `${runtime.label}: ${runtime.version || runtime.installDetail}`);
    } else {
      const used = (config?.agents || []).some((agent) => normalizeRuntime(agent.runtime) === runtime.id);
      add(used ? "error" : "info", `runtime:${runtime.id}`, runtime.installDetail);
    }
  }
}

function compareProviderSettings(agent, model, providersFile, add) {
  try {
    const data = JSON.parse(fs.readFileSync(providersFile, "utf8"));
    const settings = data.providers?.["openai-compatible"]?.settings || {};
    const mismatches = [];
    if (settings.baseUrl && settings.baseUrl !== model.baseUrl) {
      mismatches.push(`baseUrl config=${model.baseUrl} profile=${settings.baseUrl}`);
    }
    if (settings.model && settings.model !== model.modelId) {
      mismatches.push(`model config=${model.modelId} profile=${settings.model}`);
    }
    if (mismatches.length) add("warn", `profile:${agent.name}`, mismatches.join("; "));
    else add("ok", `profile:${agent.name}`, "Provider settings match config.");
  } catch (error) {
    add("warn", `profile:${agent.name}`, `Could not inspect providers.json: ${error.message}`);
  }
}

async function checkModelEndpoint(alias, model, add) {
  const url = model.baseUrl.replace(/\/+$/, "") + "/models";
  const headers = {};
  if (model.apiKeyEnv) {
    const key = readEnvValue(model.apiKeyEnv);
    if (!key) {
      add("warn", `model:${alias}`, `Missing env ${model.apiKeyEnv} in process or ${ENV_FILE}`);
      return;
    }
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
    if (!res.ok) {
      add("warn", `model:${alias}`, `${url} returned HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    const ids = extractModelIds(body);
    if (!ids.length) {
      add("warn", `model:${alias}`, `${url} returned no model IDs.`);
      return;
    }
    if (ids.includes(model.modelId)) {
      add("ok", `model:${alias}`, "Endpoint reachable and model listed.");
    } else {
      add("warn", `model:${alias}`, `Endpoint reachable, but model ID not listed: ${model.modelId}. Listed: ${ids.slice(0, 10).join(", ")}`);
    }
  } catch (error) {
    add("warn", `model:${alias}`, `Endpoint check failed for ${url}: ${error.message}`);
  }
}

export function formatDoctor(report) {
  const lines = [`Fleet Doctor (${report.ok ? "ok" : "issues found"})`, ""];
  for (const check of report.checks) {
    const marker = check.level === "ok" ? "OK" : check.level.toUpperCase();
    lines.push(`[${marker}] ${check.title}`);
    if (check.detail) lines.push(`  ${check.detail}`);
  }
  return lines.join("\n");
}
