import test from "node:test";
import assert from "node:assert/strict";
import { parseLegacyScript, buildConfigFromLegacy, buildDefaultConfig } from "../src/migrate.js";

const legacy = `AGENTS=(
  "coord|https://integrate.api.nvidia.com/v1|z-ai/glm-5.1|NVIDIA_1_API_KEY|final|final coordinator|high|false"
  "recon-a|http://localhost:1234/v1|qwen/qwen3.6-27b/SilverMacOne|NONE|recon|repo mapper|medium|true"
)

PHASE_MODES=(
  "recon|parallel"
  "final|sequential"
)`;

test("parses legacy bash arrays", () => {
  const parsed = parseLegacyScript(legacy);
  assert.equal(parsed.agents.length, 2);
  assert.equal(parsed.agents[0].name, "coord");
  assert.equal(parsed.phaseModes[0].mode, "parallel");
});

test("builds editable config documents", () => {
  const generated = buildConfigFromLegacy(parseLegacyScript(legacy));
  assert.equal(generated.agents.agents.length, 2);
  assert.ok(generated.models.models["glm-5-1-nvidia-1-api-key"]);
  const qwen = Object.values(generated.models.models).find((model) => model.modelId.includes("qwen"));
  assert.deepEqual(qwen.modalities, ["text", "image"]);
  assert.equal(generated.pipelines.pipelines.default.phases.some((phase) => phase.name === "implement"), false);
  assert.equal(generated.pipelines.pipelines.implement.phases.some((phase) => phase.name === "implement"), true);
});

test("builds a starter config without legacy bash", () => {
  const generated = buildDefaultConfig();
  assert.ok(generated.models.models["local-model"]);
  assert.ok(generated.agents.agents.some((agent) => agent.name === "coder"));
  assert.ok(generated.pipelines.pipelines.default);
  assert.ok(generated.pipelines.pipelines.implement);
});
