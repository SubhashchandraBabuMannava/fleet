import fs from "node:fs";
import path from "node:path";
import { loadConfig, getAgent } from "./config.js";
import { assertModalities, inferRequiredModalities } from "./prompts.js";
import { assertRuntimeCompatibility, normalizeRuntime, runRuntimeAgent, runtimeCommandPreview, runtimeCompatibilityIssues, runtimeMetadata } from "./runtimes.js";
import { bytesLimit, ensureDir, listFiles, readText, runCapture, timestamp, writeText } from "./util.js";

export function selectPipeline(config, implement = false, name = null) {
  const pipelineName = name || (implement ? "implement" : "default");
  const pipeline = config.pipelines[pipelineName];
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineName}`);
  return { pipelineName, pipeline };
}

export function dryRun({ task, cwd = process.cwd(), implement = false, pipelineName = null, requires = [], worktree = false }) {
  const config = loadConfig();
  const selected = selectPipeline(config, implement, pipelineName);
  const required = inferRequiredModalities(task, requires);
  assertModalities({ config, pipeline: selected.pipeline, required });
  const runtimeIssues = runtimeCompatibilityIssues({
    config,
    pipeline: selected.pipeline,
    required,
    execution: "dry-run",
    worktree
  });
  const blocking = runtimeIssues.filter((item) => item.level === "error");
  if (blocking.length) {
    throw new Error(`Runtime gate failed:\n${blocking.map((item) => `${item.title}: ${item.detail}`).join("\n")}`);
  }

  const lines = [
    `Pipeline: ${selected.pipelineName}`,
    `Project: ${cwd}`,
    `Task: ${task}`,
    `Required modalities: ${required.join(", ")}`,
    ""
  ];
  if (runtimeIssues.length) {
    lines.push("Runtime notes:");
    for (const item of runtimeIssues) lines.push(`- ${item.level.toUpperCase()} ${item.title}: ${item.detail}`);
    lines.push("");
  }

  for (const phase of selected.pipeline.phases) {
    if (phase.type === "diff") {
      lines.push(`== ${phase.name} [diff capture] ==`);
      lines.push("git diff > diff.patch");
      lines.push("");
      continue;
    }
    lines.push(`== ${phase.name} (${phase.mode}) ==`);
    for (const agentName of phase.agents || []) {
      const agent = getAgent(config, agentName);
      const runtimeId = normalizeRuntime(agent.runtime);
      const runtime = runtimeMetadata(runtimeId);
      lines.push(`${agent.name} [${runtime?.label || runtimeId}]: ${runtimeCommandPreview({ config, agent, phase, task, cwd, worktree })}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runPipeline({
  task,
  cwd = process.cwd(),
  implement = false,
  pipelineName = null,
  requires = [],
  maxAttempts = 1,
  retrySleepMs = 0,
  worktree = false,
  onOutput = (text) => process.stdout.write(text)
}) {
  const config = loadConfig();
  const selected = selectPipeline(config, implement, pipelineName);
  const required = inferRequiredModalities(task, requires);
  assertModalities({ config, pipeline: selected.pipeline, required });
  assertRuntimeCompatibility({
    config,
    pipeline: selected.pipeline,
    required,
    execution: "run",
    worktree
  });

  const runId = timestamp();
  const runDir = path.join(cwd, ".cline-runs", runId);
  ensureDir(runDir);
  const manifest = {
    runId,
    status: "running",
    startedAt: new Date().toISOString(),
    projectDir: cwd,
    task,
    pipeline: selected.pipelineName,
    requiredModalities: required,
    phases: []
  };
  writeManifest(runDir, manifest);

  try {
    for (const phase of selected.pipeline.phases) {
      if (phase.type === "diff") {
        captureDiff(runDir, cwd);
        manifest.phases.push({ name: phase.name, type: "diff", status: "done" });
        writeManifest(runDir, manifest);
        continue;
      }
      onOutput(`\n=====================================================================\n`);
      onOutput(`Phase: ${phase.name} (${phase.mode})\n`);
      const input = inputForPhase(runDir, phase);
      const agents = (phase.agents || []).map((name) => getAgent(config, name));
      const phaseResult = { name: phase.name, mode: phase.mode, agents: [], status: "running" };
      manifest.phases.push(phaseResult);
      writeManifest(runDir, manifest);

      const runOne = async (agent) => {
        const runtimeId = normalizeRuntime(agent.runtime);
        onOutput(`== [${phase.name}] ${agent.name} (${runtimeId}) ==\n`);
        const result = await runRuntimeAgent({
          config,
          agent,
          phase,
          task,
          cwd,
          runDir,
          input,
          maxAttempts,
          retrySleepMs,
          worktree,
          onOutput
        });
        phaseResult.agents.push({
          name: agent.name,
          runtime: runtimeId,
          ok: result.ok,
          status: result.status,
          output: path.basename(result.mdFile),
          log: path.basename(result.jsonlFile)
        });
        writeManifest(runDir, manifest);
        if (!result.ok) throw new Error(`${phase.name}/${agent.name} failed`);
      };

      if (phase.mode === "parallel") {
        const settled = await Promise.allSettled(agents.map((agent) => runOne(agent)));
        const failed = settled.find((item) => item.status === "rejected");
        if (failed) throw failed.reason;
      } else {
        for (const agent of agents) await runOne(agent);
      }
      phaseResult.status = "done";
      writeManifest(runDir, manifest);
    }

    writeSummary(runDir, selected.pipeline);
    manifest.status = "done";
    manifest.endedAt = new Date().toISOString();
    writeManifest(runDir, manifest);
    onOutput(`\nDone. Reports: ${runDir}\n`);
    return { ok: true, runDir, manifest };
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    manifest.endedAt = new Date().toISOString();
    writeManifest(runDir, manifest);
    writeText(path.join(runDir, "summary.md"), `# Run failed\n\n${error.message}\n`);
    throw error;
  }
}

function writeManifest(runDir, manifest) {
  writeText(path.join(runDir, "run.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function inputForPhase(runDir, phase) {
  const pieces = [];
  for (const input of phase.inputs || []) {
    if (input === "diff") {
      const diff = path.join(runDir, "diff.patch");
      if (fs.existsSync(diff)) pieces.push(section("diff.patch", readText(diff)));
      continue;
    }
    const files = listFiles(runDir, (file) => path.basename(file).startsWith(`${input}-`) && file.endsWith(".md"));
    for (const file of files) pieces.push(section(path.basename(file), readText(file)));
  }
  return bytesLimit(pieces.join("\n\n"), phase.maxInputBytes || 120000);
}

function section(name, body) {
  return `# Input: ${name}\n\n${body}`;
}

export function captureDiff(runDir, cwd) {
  const diff = path.join(runDir, "diff.patch");
  const inside = runCapture("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.ok) {
    const result = runCapture("git", ["diff"], { cwd });
    writeText(diff, result.stdout || "");
    return diff;
  }
  const summaries = listFiles(runDir, (file) => path.basename(file).startsWith("implement-") && file.endsWith(".md"))
    .map((file) => section(path.basename(file), readText(file)))
    .join("\n\n");
  writeText(diff, summaries || "Not a git repo and no implementation summaries were found.\n");
  return diff;
}

function writeSummary(runDir, pipeline) {
  const finalFiles = listFiles(runDir, (file) => path.basename(file).startsWith("final-") && file.endsWith(".md"));
  const reviewFiles = listFiles(runDir, (file) => path.basename(file).startsWith("review-") && file.endsWith(".md"));
  const body = [
    "# Fleet Run Summary",
    "",
    `Pipeline: ${pipeline.description || "unnamed"}`,
    "",
    finalFiles.length ? "## Final" : "## Latest Outputs",
    "",
    ...(finalFiles.length ? finalFiles : reviewFiles).map((file) => section(path.basename(file), readText(file)))
  ].join("\n");
  writeText(path.join(runDir, "summary.md"), body);
}
