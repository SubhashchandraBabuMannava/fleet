import test from "node:test";
import assert from "node:assert/strict";
import { analyzeClineJsonl, buildClineCommand, clineCommandPreview, extractMarkdown } from "../src/cline.js";

const config = {
  models: {
    glm: {
      provider: "openai-compatible",
      modelId: "z-ai/glm-5.1",
      modalities: ["text"],
      contextWindow: 65536,
      reasoning: "high"
    }
  },
  agents: []
};
const agent = {
  name: "planner",
  role: "planner",
  model: "glm",
  profile: "planner",
  thinking: "high",
  autoApprove: true
};
const phase = {
  name: "plan",
  readOnly: true,
  compaction: "basic",
  maxOutputWords: 2000
};

test("builds Cline command with structured flags", () => {
  const { cmd, args } = buildClineCommand({ config, agent, phase, task: "test task", cwd: "/tmp/project" });
  assert.equal(cmd, "cline");
  assert.ok(args.includes("--config"));
  assert.ok(args.includes("--cwd"));
  assert.ok(args.includes("--provider"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--system"));
  assert.ok(args.includes("--json"));
  assert.match(args[args.indexOf("--config") + 1], /planner$/);
  assert.equal(args[args.indexOf("--model") + 1], "z-ai/glm-5.1");
  assert.equal(args.at(-1).includes("test task"), true);
});

test("preview redacts prompts", () => {
  const preview = clineCommandPreview({ config, agent, phase, task: "secret task", cwd: "/tmp/project" });
  assert.match(preview, /\[system prompt\]/);
  assert.match(preview, /\[user prompt\]/);
  assert.doesNotMatch(preview, /secret task/);
});

test("analyzes completed Cline JSON output", () => {
  const raw = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "done text" } }),
    JSON.stringify({ type: "run_result", finishReason: "completed", text: "done text" })
  ].join("\n");
  const analysis = analyzeClineJsonl(raw);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.markdown, "done text");
  assert.equal(extractMarkdown(raw), "done text");
});

test("treats aborted Cline JSON output as failure even with process success", () => {
  const raw = [
    JSON.stringify({ type: "agent_event", event: { type: "error", recoverable: true, error: { message: "tool failed" } } }),
    JSON.stringify({ type: "run_result", finishReason: "aborted", text: "" }),
    JSON.stringify({ type: "run_aborted", reason: "external_abort", message: "aborted by another client" })
  ].join("\n");
  const analysis = analyzeClineJsonl(raw);
  assert.equal(analysis.ok, false);
  assert.equal(analysis.aborted, true);
  assert.match(analysis.error, /aborted|finishReason/);
});
