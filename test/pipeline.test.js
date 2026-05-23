import test from "node:test";
import assert from "node:assert/strict";
import { selectPipeline } from "../src/pipeline.js";
import { assertModalities } from "../src/prompts.js";

const config = {
  models: {
    text: { modalities: ["text"] },
    vision: { modalities: ["text", "image"] }
  },
  agents: [
    { name: "planner", model: "text" },
    { name: "recon", model: "vision" }
  ],
  pipelines: {
    default: { phases: [{ name: "plan", mode: "sequential", agents: ["planner"] }] },
    implement: { phases: [{ name: "implement", mode: "sequential", agents: ["planner"] }] }
  }
};

test("selects safe pipeline unless implement is requested", () => {
  assert.equal(selectPipeline(config, false).pipelineName, "default");
  assert.equal(selectPipeline(config, true).pipelineName, "implement");
});

test("modality gate blocks image work on text-only agents", () => {
  assert.throws(() => assertModalities({
    config,
    pipeline: config.pipelines.default,
    required: ["text", "image"]
  }), /lacks required modality/);
});

test("modality gate allows vision-capable agents", () => {
  assert.doesNotThrow(() => assertModalities({
    config,
    pipeline: { phases: [{ name: "recon", mode: "parallel", agents: ["recon"] }] },
    required: ["text", "image"]
  }));
});
