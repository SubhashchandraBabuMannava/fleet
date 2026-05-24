import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("builds an empty first-run config", () => {
  const out = runModule(`
    const { buildInitialConfig } = await import("./src/setup.js");
    console.log(JSON.stringify(buildInitialConfig()));
  `);
  assert.deepEqual(out.models, { models: {} });
  assert.deepEqual(out.agents, { agents: [] });
  assert.deepEqual(out.pipelines, { pipelines: {} });
});

test("missing config is represented as setup-needed state", () => {
  const root = tempRoot("fleet-setup-state-");
  const out = runModule(`
    const { structuredState } = await import("./src/config.js");
    const state = structuredState();
    console.log(JSON.stringify({ setupNeeded: state.setupNeeded, models: state.models, agents: state.agents, pipelines: state.pipelines, raw: state.raw.models }));
  `, envFor(root));
  assert.equal(out.setupNeeded, true);
  assert.deepEqual(out.models, []);
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.pipelines, []);
  assert.match(out.raw, /models/);
});

test("init writes clean empty config files", () => {
  const root = tempRoot("fleet-init-");
  const out = runModule(`
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { initConfig } = await import("./src/setup.js");
    const result = initConfig();
    console.log(JSON.stringify({
      models: result.models,
      agents: result.agents,
      modelsFile: fs.existsSync(path.join(process.env.FLEET_CONFIG_DIR, "models.yaml")),
      agentsText: fs.readFileSync(path.join(process.env.FLEET_CONFIG_DIR, "agents.yaml"), "utf8").trim()
    }));
  `, envFor(root));
  assert.equal(out.models, 0);
  assert.equal(out.agents, 0);
  assert.equal(out.modelsFile, true);
  assert.equal(out.agentsText, "agents: []");
});

test("factory reset removes only configured Fleet state", () => {
  const root = tempRoot("fleet-reset-");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(project, ".fleet-runs"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "models.yaml"), "models: {}\n");
  fs.writeFileSync(path.join(root, "home", "secret"), "x");
  fs.writeFileSync(path.join(project, ".fleet-runs", "run"), "x");

  const out = runModule(`
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { resetFleet } = await import("./src/reset.js");
    resetFleet({ factory: true, yes: true, runs: true, cwd: ${JSON.stringify(project)} });
    console.log(JSON.stringify({
      config: fs.existsSync(process.env.FLEET_CONFIG_DIR),
      home: fs.existsSync(process.env.FLEET_HOME),
      runs: fs.existsSync(path.join(${JSON.stringify(project)}, ".fleet-runs")),
      project: fs.existsSync(${JSON.stringify(project)})
    }));
  `, envFor(root));
  assert.deepEqual(out, { config: false, home: false, runs: false, project: true });
});

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function envFor(root) {
  return {
    ...process.env,
    FLEET_CONFIG_DIR: path.join(root, "config"),
    FLEET_HOME: path.join(root, "home")
  };
}

function runModule(source, env = process.env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout);
}
