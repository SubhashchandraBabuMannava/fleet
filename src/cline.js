import fs from "node:fs";
import path from "node:path";
import { agentProfileDir, getModel } from "./config.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import { commandPreview, spawnCollect, writeText } from "./util.js";

export function buildClineCommand({ config, agent, phase, task, cwd, worktree = false }) {
  const model = getModel(config, agent.model);
  const args = [
    "--config", agentProfileDir(agent),
    "--cwd", cwd,
    "--provider", model.provider || "openai-compatible",
    "--model", model.modelId,
    "--system", buildSystemPrompt({ config, agent, phase }),
    "--thinking", agent.thinking || model.reasoning || "medium",
    "--auto-approve", String(agent.autoApprove ?? false),
    "--compaction", phase.compaction || "basic",
    "--json"
  ];

  if (phase.readOnly) args.unshift("--plan");
  if (worktree) args.push("--worktree");
  args.push(buildUserPrompt({ task, agent, phase }));
  return { cmd: "cline", args };
}

export function clineCommandPreview(options) {
  const { cmd, args } = buildClineCommand(options);
  const redacted = args.map((arg, index) => {
    if (args[index - 1] === "--system") return "[system prompt]";
    if (index === args.length - 1) return "[user prompt]";
    return arg;
  });
  return commandPreview(cmd, redacted);
}

export function extractMarkdown(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.text === "string" && msg.text.trim()) out.push(msg.text);
      else if (typeof msg.content === "string" && msg.content.trim()) out.push(msg.content);
      else if (msg.type === "run_result" && typeof msg.text === "string" && msg.text.trim()) out.push(msg.text);
      else if (msg.event?.type === "content_end" && msg.event.contentType === "text" && msg.event.text?.trim()) out.push(msg.event.text);
      else if (msg.event?.type === "done" && msg.event.text?.trim()) out.push(msg.event.text);
      else if (msg.type && msg.say && typeof msg.say === "string") out.push(msg.say);
    } catch {
      out.push(line);
    }
  }
  return dedupeAdjacent(out).join("\n");
}

export function analyzeClineJsonl(raw) {
  const text = [];
  let finishReason = null;
  let aborted = false;
  let error = "";

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.type === "run_aborted") {
      aborted = true;
      error ||= msg.message || msg.reason || "Cline run aborted.";
    }
    if (msg.type === "error") {
      error ||= msg.message || "Cline emitted an error.";
    }
    if (msg.type === "run_result") {
      finishReason = msg.finishReason || null;
      if (msg.text?.trim()) text.push(msg.text.trim());
      if (finishReason && finishReason !== "completed") {
        error ||= `Cline finishReason=${finishReason}`;
      }
    }

    const event = msg.event;
    if (event?.type === "content_end" && event.contentType === "text" && event.text?.trim()) {
      text.push(event.text.trim());
    }
    if (event?.type === "done" && event.text?.trim()) {
      text.push(event.text.trim());
    }
    if (event?.type === "error" && event.error?.message && event.recoverable === false) {
      error ||= event.error.message;
    }
  }

  const markdown = dedupeAdjacent(text).join("\n");
  return {
    ok: !aborted && !error && (finishReason === null || finishReason === "completed"),
    finishReason,
    aborted,
    error,
    markdown
  };
}

export async function runClineAgent({
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
  const { cmd, args } = buildClineCommand({ config, agent, phase, task, cwd, worktree });
  const base = `${phase.name}-${agent.name}`;
  const jsonlFile = path.join(runDir, `${base}.jsonl`);
  const mdFile = path.join(runDir, `${base}.md`);
  const promptFile = path.join(runDir, `${base}.prompt.txt`);
  writeText(promptFile, args[args.length - 1]);

  let last = null;
  let lastClineIssue = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptFile = path.join(runDir, `${base}.attempt-${attempt}.jsonl`);
    onOutput(`[${phase.name}/${agent.name}] attempt ${attempt}/${maxAttempts}\n`);
    const result = await spawnCollect(cmd, args, {
      cwd,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      onStdout: (text) => onOutput(text),
      onStderr: (text) => onOutput(text)
    });
    last = result;
    const raw = `${result.stdout || ""}${result.stderr || ""}`;
    writeText(attemptFile, raw);
    const analysis = analyzeClineJsonl(raw);
    lastClineIssue = analysis.ok ? "" : analysis.error || "Cline did not complete.";

    if (result.ok && analysis.ok) {
      fs.copyFileSync(attemptFile, jsonlFile);
      writeText(mdFile, analysis.markdown || extractMarkdown(raw) || raw);
      onOutput(`[${phase.name}/${agent.name}] success\n`);
      return { ok: true, jsonlFile, mdFile, status: result.status };
    }

    if (result.ok && !analysis.ok) {
      onOutput(`[${phase.name}/${agent.name}] failed: ${lastClineIssue}\n`);
    } else {
      onOutput(`[${phase.name}/${agent.name}] failed with exit ${result.status}\n`);
    }
    if (attempt < maxAttempts && retrySleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retrySleepMs));
    }
  }

  const failure = [
    "# Agent failed",
    "",
    `- Agent: ${agent.name}`,
    `- Phase: ${phase.name}`,
    `- Attempts: ${maxAttempts}`,
    `- Exit: ${last?.status ?? "unknown"}`,
    ...(lastClineIssue ? [`- Cline result: ${lastClineIssue}`] : []),
    "",
    "## Last output",
    "",
    `${last?.stdout || ""}${last?.stderr || ""}`.trim()
  ].join("\n");
  writeText(mdFile, failure);
  writeText(jsonlFile, `${last?.stdout || ""}${last?.stderr || ""}`);
  return { ok: false, jsonlFile, mdFile, status: last?.status === 0 && lastClineIssue ? 1 : (last?.status ?? -1) };
}

function dedupeAdjacent(values) {
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    if (out[out.length - 1] !== trimmed) out.push(trimmed);
  }
  return out;
}
