import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RUNTIME, RUNTIME_DEFINITIONS } from "../src/runtime-definitions.js";
import {
  normalizeRuntime,
  discoverModels,
  runtimeCommandPreview,
  runtimeCompatibilityIssues,
  suggestModelId
} from "../src/runtimes.js";

const config = {
  models: {
    glm: {
      provider: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      modelId: "z-ai/glm-5.1",
      modalities: ["text"],
      contextWindow: 65536,
      outputBudget: 2000,
      reasoning: "high"
    },
    qwen: {
      provider: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      modelId: "qwen-pc",
      modalities: ["text", "image"],
      contextWindow: 131072,
      outputBudget: 4000,
      reasoning: "medium"
    }
  },
  agents: [
    {
      name: "planner",
      role: "planner",
      runtime: "openai-compatible-direct",
      model: "glm",
      permissions: { mode: "read-only", tools: ["read"], mcp: "none" }
    },
    {
      name: "coder",
      role: "coder",
      runtime: "openai-compatible-direct",
      model: "glm",
      permissions: { mode: "write", tools: ["read", "edit"], mcp: "none" }
    },
    {
      name: "custom",
      role: "custom worker",
      runtime: "custom-command",
      model: "qwen",
      permissions: { mode: "read-only", tools: ["read"], mcp: "profile" }
    }
  ]
};

test("runtime definitions include the supported worker options", () => {
  assert.equal(DEFAULT_RUNTIME, "cline");
  for (const id of ["cline", "claude-code", "codex", "openai-compatible-direct", "custom-command", "aider"]) {
    assert.ok(RUNTIME_DEFINITIONS[id], id);
  }
});

test("missing runtime normalizes to cline", () => {
  assert.equal(normalizeRuntime(null), "cline");
  assert.equal(normalizeRuntime("codex"), "codex");
});

test("direct runtime preview is read-only and redacts prompts", () => {
  const preview = runtimeCommandPreview({
    config,
    agent: config.agents[0],
    phase: { name: "plan", readOnly: true, maxOutputWords: 500 },
    task: "secret planning task",
    cwd: "/tmp/project"
  });
  assert.match(preview, /openai-compatible-direct/);
  assert.match(preview, /chat\/completions/);
  assert.doesNotMatch(preview, /secret planning task/);
});

test("direct runtime rejects write roles and phases", () => {
  const issues = runtimeCompatibilityIssues({
    config,
    pipeline: { phases: [{ name: "implement", mode: "sequential", readOnly: false, agents: ["coder"] }] },
    required: ["text"],
    execution: "dry-run"
  });
  assert.ok(issues.some((issue) => issue.code === "direct-runtime-write-role"));
  assert.ok(issues.some((issue) => issue.code === "runtime-not-write-capable"));
});

test("custom command runtime reports missing command and MCP warning", () => {
  const issues = runtimeCompatibilityIssues({
    config,
    pipeline: { phases: [{ name: "review", mode: "sequential", readOnly: true, agents: ["custom"] }] },
    required: ["text"],
    execution: "dry-run"
  });
  assert.ok(issues.some((issue) => issue.code === "custom-command-missing"));
  assert.ok(issues.some((issue) => issue.code === "runtime-no-mcp"));
});

test("model discovery suggests parent endpoint IDs for host-suffixed local IDs", () => {
  assert.equal(
    suggestModelId("model-family/OfficeMac", ["model-family"]),
    "model-family"
  );
});

test("model discovery can probe LM Studio before config exists", async () => {
  const endpoints = await discoverModels(null, {
    endpoints: [{ baseUrl: "http://localhost:1234/v1", apiKeyEnv: null }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "qwen-pc" }] })
    })
  });
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].ok, true);
  assert.deepEqual(endpoints[0].ids, ["qwen-pc"]);
});
