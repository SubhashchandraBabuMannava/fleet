import test from "node:test";
import assert from "node:assert/strict";
import { buildClineCommand, clineCommandPreview } from "../src/cline.js";

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
  assert.equal(args[args.indexOf("--model") + 1], "z-ai/glm-5.1");
  assert.equal(args.at(-1).includes("test task"), true);
});

test("preview redacts prompts", () => {
  const preview = clineCommandPreview({ config, agent, phase, task: "secret task", cwd: "/tmp/project" });
  assert.match(preview, /\[system prompt\]/);
  assert.match(preview, /\[user prompt\]/);
  assert.doesNotMatch(preview, /secret task/);
});
