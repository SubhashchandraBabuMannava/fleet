#!/usr/bin/env node
import process from "node:process";
import { initConfig } from "./migrate.js";
import { doctor, formatDoctor } from "./doctor.js";
import { dryRun, runPipeline } from "./pipeline.js";
import { startStudio } from "./studio.js";
import { formatRuns } from "./runs.js";
import { expandHome } from "./paths.js";
import { loadConfig } from "./config.js";
import { ROLE_PRESETS } from "./presets.js";
import { runtimeStatuses } from "./runtimes.js";

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd || "help") {
      case "init":
        return cmdInit(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "run":
        return await cmdRun(rest);
      case "studio":
        return cmdStudio(rest);
      case "runs":
        return cmdRuns(rest);
      case "roles":
        return cmdRoles();
      case "models":
        return cmdModels();
      case "pipelines":
        return cmdPipelines();
      case "runtimes":
        return cmdRuntimes();
      case "validate":
        return cmdValidate();
      case "help":
      case "-h":
      case "--help":
        console.log(usage());
        return 0;
      default:
        throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (["--implement", "--dry-run", "--worktree", "--force", "--json"].includes(arg)) {
      flags[arg.slice(2)] = true;
      continue;
    }
    const key = arg.replace(/^-+/, "");
    const value = args[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    flags[key] = value;
    i += 1;
  }
  return { flags, positional };
}

function cmdInit(args) {
  const { flags } = parseFlags(args);
  const result = initConfig({ source: flags.source, force: !!flags.force });
  console.log(`Initialized Fleet config in ${result.configDir}`);
  console.log(`Models: ${result.models}`);
  console.log(`Agents: ${result.agents}`);
  console.log(`Pipelines: ${result.pipelines.join(", ")}`);
  return 0;
}

async function cmdDoctor(args) {
  const { flags } = parseFlags(args);
  const report = await doctor();
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctor(report));
  return report.ok ? 0 : 1;
}

async function cmdRun(args) {
  const { flags, positional } = parseFlags(args);
  const task = positional.join(" ").trim() || "Analyze this repo and propose a safe implementation plan";
  const cwd = expandHome(flags.cwd || flags.c || process.cwd());
  const requires = String(flags.requires || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const opts = {
    task,
    cwd,
    implement: !!flags.implement,
    pipelineName: flags.pipeline || null,
    requires,
    worktree: !!flags.worktree
  };

  if (flags["dry-run"]) {
    console.log(dryRun(opts));
    return 0;
  }

  await runPipeline({
    ...opts,
    maxAttempts: Number(flags["max-attempts"] || process.env.FLEET_MAX_ATTEMPTS || 1),
    retrySleepMs: Number(flags["retry-sleep-seconds"] || process.env.FLEET_RETRY_SLEEP_SECONDS || 0) * 1000
  });
  return 0;
}

function cmdStudio(args) {
  const { flags } = parseFlags(args);
  const server = startStudio({
    host: flags.host || process.env.FLEET_STUDIO_HOST || "127.0.0.1",
    port: Number(flags.port || process.env.FLEET_STUDIO_PORT || 3127)
  });
  globalThis.__fleetStudioServer = server;
  return new Promise((resolve, reject) => {
    server.on("close", resolve);
    server.on("error", reject);
  });
}

function cmdRuns(args) {
  const { flags, positional } = parseFlags(args);
  const projectDir = expandHome(flags.project || flags.cwd || flags.c || process.cwd());
  console.log(formatRuns(projectDir, positional[0] || null, positional[1] || null));
  return 0;
}

function cmdRoles() {
  for (const role of ROLE_PRESETS) {
    console.log(`${role.id}\t${role.phase}\t${role.label}\t${role.role}`);
  }
  return 0;
}

function cmdModels() {
  const config = loadConfig();
  for (const [alias, model] of Object.entries(config.models)) {
    console.log(`${alias}\t${model.modelId}\t${model.baseUrl}\t${(model.modalities || []).join(",")}\tctx=${model.contextWindow || "?"}`);
  }
  return 0;
}

function cmdPipelines() {
  const config = loadConfig();
  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    const phases = (pipeline.phases || []).map((phase) => phase.name).join(" -> ");
    console.log(`${name}\t${phases}`);
  }
  return 0;
}

function cmdRuntimes() {
  const config = loadConfig();
  for (const runtime of runtimeStatuses(config)) {
    const installed = runtime.installed ? "installed" : "missing";
    const version = runtime.version ? ` ${runtime.version}` : "";
    console.log(`${runtime.id}\t${installed}\t${runtime.maturity}\twrite=${runtime.supportsWrite}\tmcp=${runtime.supportsMcp}\t${runtime.label}${version}`);
  }
  return 0;
}

function cmdValidate() {
  const config = loadConfig();
  console.log(`Config OK: ${Object.keys(config.models).length} models, ${config.agents.length} agents, ${Object.keys(config.pipelines).length} pipelines`);
  return 0;
}

function usage() {
  return `Usage:
  fleet init [--force] [--source /path/to/legacy-script]
  fleet doctor [--json]
  fleet run [--dry-run] [--implement] [--worktree] [--cwd DIR] [--pipeline NAME] [--requires vision] "task"
  fleet studio [--host 127.0.0.1] [--port 3127]
  fleet runs [--project DIR] [run-id] [file]
  fleet roles
  fleet models
  fleet pipelines
  fleet runtimes
  fleet validate

Defaults:
  run uses the read-only default pipeline.
  --implement selects the implementation pipeline.
  --dry-run prints the phase graph and worker commands without model calls.`;
}

const code = await main();
if (typeof code === "number") process.exit(code);
