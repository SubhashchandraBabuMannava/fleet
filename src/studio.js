import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { CONFIG_DIR, MODELS_FILE, AGENTS_FILE, PIPELINES_FILE, PROMPTS_DIR, expandHome } from "./paths.js";
import { loadRawConfig, saveRawConfig, promptsList, structuredState, saveStructuredState, loadConfig } from "./config.js";
import { doctor, formatDoctor } from "./doctor.js";
import { dryRun, runPipeline } from "./pipeline.js";
import { listRuns, listRunFiles, readRunFile } from "./runs.js";
import { ensureDir, readText, timestamp, writeText } from "./util.js";
import { MODEL_TEMPLATES, PIPELINE_TEMPLATES, ROLE_PRESETS } from "./presets.js";
import { discoverModels, runtimeCompatibilityIssues, runtimeStatuses } from "./runtimes.js";

const jobs = new Map();

export function createStudioApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/", (_, res) => res.type("html").send(INDEX_HTML));

  app.get("/api/config", (_, res, next) => {
    try {
      res.json({
        configDir: CONFIG_DIR,
        models: readText(MODELS_FILE),
        agents: readText(AGENTS_FILE),
        pipelines: readText(PIPELINES_FILE)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/state", (_, res, next) => {
    try {
      let config = null;
      try {
        config = loadConfig();
      } catch {
        config = null;
      }
      res.json({
        ...structuredState(),
        runtimes: runtimeStatuses(config),
        presets: {
          roles: ROLE_PRESETS,
          models: MODEL_TEMPLATES,
          pipelines: PIPELINE_TEMPLATES
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/templates", (_, res) => {
    res.json({
      roles: ROLE_PRESETS,
      models: MODEL_TEMPLATES,
      pipelines: PIPELINE_TEMPLATES,
      teams: teamTemplates()
    });
  });

  app.get("/api/runtimes", (_, res, next) => {
    try {
      let config = null;
      try {
        config = loadConfig();
      } catch {
        config = null;
      }
      res.json({ runtimes: runtimeStatuses(config) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/discover/models", async (_, res, next) => {
    try {
      res.json({ endpoints: await discoverModels(loadConfig()) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/issues", async (_, res, next) => {
    try {
      const config = loadConfig();
      const report = await doctor();
      const compatibility = [];
      for (const [name, pipeline] of Object.entries(config.pipelines)) {
        compatibility.push(...runtimeCompatibilityIssues({
          config,
          pipeline,
          required: ["text"],
          execution: "dry-run",
          worktree: false
        }).map((item) => ({ ...item, pipeline: name })));
      }
      res.json({ issues: normalizeIssues(report, compatibility), report, compatibility });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/state", (req, res, next) => {
    try {
      ensureDir(CONFIG_DIR);
      const stamp = timestamp();
      for (const file of [MODELS_FILE, AGENTS_FILE, PIPELINES_FILE]) {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${stamp}`);
      }
      const state = saveStructuredState(req.body || {});
      loadConfig();
      res.json({ ok: true, backupStamp: stamp, ...state });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/config", (req, res, next) => {
    try {
      ensureDir(CONFIG_DIR);
      const stamp = timestamp();
      for (const file of [MODELS_FILE, AGENTS_FILE, PIPELINES_FILE]) {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${stamp}`);
      }
      saveRawConfig({
        models: yaml.load(req.body.models || "{}") || {},
        agents: yaml.load(req.body.agents || "{}") || {},
        pipelines: yaml.load(req.body.pipelines || "{}") || {}
      });
      res.json({ ok: true, backupStamp: stamp, raw: loadRawConfig() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/prompts", (_, res, next) => {
    try {
      res.json({ promptsDir: PROMPTS_DIR, prompts: promptsList() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/prompts/:agent", (req, res, next) => {
    try {
      if (!/^[A-Za-z0-9_.-]+$/.test(req.params.agent)) throw new Error("Invalid prompt name");
      ensureDir(PROMPTS_DIR);
      const file = path.join(PROMPTS_DIR, `${req.params.agent}.md`);
      writeText(file, req.body.content || "");
      res.json({ ok: true, file });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/prompts/:agent", (req, res, next) => {
    try {
      const file = path.join(PROMPTS_DIR, `${req.params.agent}.md`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doctor", async (_, res, next) => {
    try {
      const report = await doctor();
      res.json({ report, text: formatDoctor(report) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/jobs", (req, res, next) => {
    try {
      const job = createJob(req.body || {});
      res.json({ id: job.id });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs/:id/events", (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job) return next(Object.assign(new Error("Job not found"), { statusCode: 404 }));
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`event: output\ndata: ${JSON.stringify(job.output)}\n\n`);
    if (job.status !== "running") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`);
      res.end();
      return;
    }
    job.listeners.add(res);
    req.on("close", () => job.listeners.delete(res));
  });

  app.get("/api/runs", (req, res, next) => {
    try {
      const projectDir = expandHome(req.query.projectDir || process.cwd());
      res.json({ projectDir, runs: listRuns(projectDir) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:runId/files", (req, res, next) => {
    try {
      const projectDir = expandHome(req.query.projectDir || process.cwd());
      res.json({ files: listRunFiles(projectDir, req.params.runId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:runId/file", (req, res, next) => {
    try {
      const projectDir = expandHome(req.query.projectDir || process.cwd());
      res.json({ content: readRunFile(projectDir, req.params.runId, String(req.query.file || "")) });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message || "Unknown error" });
  });

  return app;
}

export function startStudio({ host = "127.0.0.1", port = 3127 } = {}) {
  const app = createStudioApp();
  return app.listen(port, host, () => {
    console.log(`Fleet Studio running at http://${host}:${port}`);
    console.log(`Config: ${CONFIG_DIR}`);
  });
}

function createJob(body) {
  const id = crypto.randomUUID();
  const job = { id, status: "running", exitCode: null, output: "", listeners: new Set() };
  jobs.set(id, job);
  const append = (text) => {
    job.output += text;
    for (const listener of job.listeners) {
      listener.write(`event: output\ndata: ${JSON.stringify(text)}\n\n`);
    }
  };
  const done = (status, exitCode = 0) => {
    job.status = status;
    job.exitCode = exitCode;
    for (const listener of job.listeners) {
      listener.write(`event: done\ndata: ${JSON.stringify({ status, exitCode })}\n\n`);
      listener.end();
    }
  };

  queueMicrotask(async () => {
    try {
      const task = body.task || "Analyze this repo and propose a safe implementation plan";
      const cwd = expandHome(body.projectDir || process.cwd());
      const requires = String(body.requires || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (body.action === "doctor") {
        append(formatDoctor(await doctor()) + "\n");
      } else if (body.action === "dry-run") {
        append(dryRun({ task, cwd, implement: !!body.implement, pipelineName: body.pipeline || null, requires, worktree: !!body.worktree }));
      } else if (body.action === "run") {
        await runPipeline({
          task,
          cwd,
          implement: !!body.implement,
          pipelineName: body.pipeline || null,
          requires,
          maxAttempts: Number(body.maxAttempts || 1),
          retrySleepMs: Number(body.retrySleepMs || 0),
          worktree: !!body.worktree,
          onOutput: append
        });
      } else {
        throw new Error(`Unknown action: ${body.action}`);
      }
      done("done", 0);
    } catch (error) {
      append(`\n[error] ${error.message}\n`);
      done("failed", 1);
    }
  });
  return job;
}

function normalizeIssues(report, compatibility = []) {
  const issues = [];
  for (const check of report.checks || []) {
    if (check.level === "ok" || check.level === "info") continue;
    issues.push({
      level: check.level,
      code: check.title.startsWith("model:") && /not listed/i.test(check.detail) ? "model-id-mismatch" : "doctor",
      title: check.title,
      detail: check.detail,
      source: "doctor"
    });
  }
  for (const item of compatibility) {
    issues.push({ ...item, source: "runtime" });
  }

  const seen = new Set();
  return issues.filter((item) => {
    const key = [item.level, item.code, item.title, item.detail, item.pipeline || ""].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function teamTemplates() {
  return [
    {
      id: "safe-review",
      label: "Safe Planning Team",
      description: "Read-only mapper, skeptic, planner, reviewers, and final coordinator.",
      roles: ["repo-mapper", "skeptic", "compactor", "planner", "reviewer", "security-reviewer", "test-reviewer", "coordinator"],
      pipeline: "default"
    },
    {
      id: "implementation",
      label: "Implementation Team",
      description: "Safe planning team plus an explicit coder role for --implement runs.",
      roles: ["repo-mapper", "skeptic", "compactor", "planner", "coder", "reviewer", "security-reviewer", "test-reviewer", "coordinator"],
      pipeline: "implement"
    },
    {
      id: "compact",
      label: "Small Local Team",
      description: "One mapper, one planner, one reviewer, and one coordinator for local models with tighter context.",
      roles: ["repo-mapper", "planner", "reviewer", "coordinator"],
      pipeline: "default"
    }
  ];
}

const INDEX_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fleet Studio</title>
<style>
:root{--bg:#f6f7f9;--side:#101827;--panel:#fff;--line:#d8dee8;--text:#182230;--muted:#667085;--accent:#0f766e;--accent2:#2563eb;--danger:#b42318;--warn:#b54708;--soft:#eef2f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;letter-spacing:0}.app{display:grid;grid-template-columns:244px 1fr;min-height:100vh}.side{background:var(--side);color:white;padding:18px}.brand{font-size:19px;font-weight:750}.sub{color:#b7c0cf;font-size:12px;margin-top:3px}.nav{display:grid;gap:6px;margin-top:22px}.nav button{background:transparent;color:#d9e0ea;border:1px solid transparent;text-align:left;border-radius:7px;padding:9px 10px}.nav button.active,.nav button:hover{background:#1f2937;border-color:#374151}.main{padding:18px;overflow:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.title{font-size:21px;font-weight:760}.muted{color:var(--muted);font-size:12px}.status{min-height:20px;color:var(--muted);font-size:12px}.panel{display:none}.panel.active{display:block}.band,.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}.card{margin:0}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}.card-title{font-weight:760;font-size:15px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}.row{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.toolbar{display:flex;justify-content:space-between;gap:12px;align-items:end;flex-wrap:wrap}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:8px;background:white}table{width:100%;border-collapse:collapse;min-width:1080px}th,td{border-bottom:1px solid var(--line);padding:7px;text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);background:#f8fafc;position:sticky;top:0}button,input,textarea,select{font:inherit}button{border:1px solid var(--line);background:white;border-radius:7px;padding:8px 10px;cursor:pointer;white-space:nowrap}button.primary{background:var(--accent);border-color:var(--accent);color:white}button.secondary{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}button.danger{border-color:#f5b4ad;color:var(--danger)}button.icon{width:34px;height:34px;padding:0;text-align:center}label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin:8px 0 4px}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:7px;padding:8px;background:white;color:var(--text);min-width:0}input[type=checkbox]{width:auto}.tiny{width:84px}.small{width:132px}.medium{width:190px}.wide{width:260px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.yaml{min-height:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.45}.prompt{min-height:500px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.45}.log,.preview{white-space:pre-wrap;background:#0b1020;color:#e5e7eb;border-radius:8px;padding:12px;min-height:360px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.list{display:grid;gap:6px;max-height:360px;overflow:auto}.list button{text-align:left}.pill,.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:4px 8px;margin:0 6px 6px 0;background:#f9fafb}.badge.ok{background:#ecfdf3;border-color:#abefc6;color:#067647}.badge.warn{background:#fffaeb;border-color:#fedf89;color:#b54708}.badge.error{background:#fef3f2;border-color:#fecdca;color:#b42318}.metric{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px}.metric strong{display:block;font-size:24px}.checkrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.split{display:grid;grid-template-columns:340px 1fr;gap:12px}.phase-row{display:grid;grid-template-columns:40px 1fr 110px 120px 1.3fr 1.1fr 90px 110px 110px 100px 100px;gap:8px;align-items:end;border-bottom:1px solid var(--line);padding:8px 0}.phase-row:last-child{border-bottom:0}.issue{border-left:4px solid var(--line);padding:8px 10px;background:#fff;border-radius:6px;margin:6px 0}.issue.warn{border-left-color:var(--warn)}.issue.error{border-left-color:var(--danger)}.wizard{counter-reset:step}.step{display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:start}.step:before{counter-increment:step;content:counter(step);width:28px;height:28px;border-radius:999px;background:#e0f2fe;color:#075985;display:grid;place-items:center;font-weight:800}@media(max-width:1100px){.app{grid-template-columns:1fr}.grid,.three,.split,.field-grid{grid-template-columns:1fr}.side{position:static}.phase-row{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<div class="app">
<aside class="side">
<div class="brand">Fleet Studio</div><div class="sub">Local agent teams</div>
<div class="nav">
<button class="active" data-tab="setup">Setup</button>
<button data-tab="overview">Home</button>
<button data-tab="models">Models</button>
<button data-tab="agents">Team</button>
<button data-tab="pipelines">Workflow</button>
<button data-tab="prompts">Prompts</button>
<button data-tab="run">Runs</button>
<button data-tab="outputs">Artifacts</button>
<button data-tab="advanced">Advanced</button>
</div>
</aside>
<main class="main">
<div class="top"><div><div class="title" id="title">Setup</div><div class="muted" id="configDir"></div><div class="status" id="status"></div></div><div class="row"><button id="reload">Reload</button><button class="primary" id="saveState">Save Team</button></div></div>
<section class="panel active" data-panel="setup">
<div class="band toolbar"><div><div class="card-title">First-run setup wizard</div><div class="muted">Follow these steps left to right. Everything saves to YAML, but you do not need to edit YAML to get started.</div></div><div class="row"><button id="discoverFromSetup">Discover Models</button><button id="doctorFromSetup">Run Doctor</button><button class="primary" data-jump="run">Dry Run</button></div></div>
<div class="cards wizard">
<div class="card step"><div><div class="card-title">Check workers</div><div class="muted">Cline is the default. Claude Code, Codex, direct API, custom commands, and Aider can be selected per role.</div><div id="runtimeCards" style="margin-top:10px"></div></div></div>
<div class="card step"><div><div class="card-title">Fix model IDs</div><div class="muted">Discover compares your configured IDs with endpoint /models results and suggests safe fixes.</div><div data-model-discovery style="margin-top:10px"></div></div></div>
<div class="card step"><div><div class="card-title">Choose team roles</div><div class="muted">Use role presets for mapper, skeptic, planner, coder, reviewers, and coordinator.</div><div class="row" style="margin-top:10px"><button data-jump="agents">Edit Team</button><button data-jump="pipelines">Edit Workflow</button></div></div></div>
<div class="card step"><div><div class="card-title">Review permissions</div><div class="muted">Default runs are read-only. Write phases require implementation mode and a write-capable runtime.</div><div class="row" style="margin-top:10px"><button data-jump="agents">Permissions</button><button data-jump="advanced">YAML</button></div></div></div>
<div class="card step"><div><div class="card-title">Run safe preview</div><div class="muted">Dry run prints phase graph and worker commands without calling models.</div><div class="row" style="margin-top:10px"><button class="primary" data-jump="run">Open Runs</button></div></div></div>
</div>
<div class="band"><div class="card-title">Current issues</div><div id="issueList"><span class="muted">Loading health checks...</span></div></div>
</section>
<section class="panel" data-panel="overview">
<div class="three"><div class="metric"><strong id="modelCount">0</strong><span>models</span></div><div class="metric"><strong id="agentCount">0</strong><span>agents</span></div><div class="metric"><strong id="pipelineCount">0</strong><span>pipelines</span></div></div>
<div class="band"><div class="row"><button class="secondary" data-jump="setup">Setup Wizard</button><button class="secondary" data-jump="models">Add Model</button><button class="secondary" data-jump="agents">Edit Team</button><button class="secondary" data-jump="pipelines">Edit Workflow</button><button class="primary" data-jump="run">Open Runs</button></div></div>
<div class="band" id="overviewSummary"></div>
</section>
<section class="panel" data-panel="models">
<div class="band toolbar"><div class="row"><div><label>Template</label><select id="modelTemplate" class="medium"></select></div><button id="addModel" class="secondary">Add Model</button></div><div class="row"><button id="discoverModels">Discover / Fix IDs</button><button id="doctorFromModels">Doctor</button></div></div>
<div class="band"><div class="card-title">Endpoint discovery</div><div data-model-discovery style="margin-top:10px"></div></div>
<div id="modelsBody" class="cards"></div>
</section>
<section class="panel" data-panel="agents">
<div class="band toolbar"><div class="row"><div><label>Role Preset</label><select id="rolePreset" class="medium"></select></div><div><label>Model</label><select id="newAgentModel" class="medium"></select></div><button id="addAgent" class="secondary">Add Role</button></div><button id="syncPrompts">Create Missing Prompts</button></div>
<div id="agentsBody" class="cards"></div>
</section>
<section class="panel" data-panel="pipelines">
<div class="band toolbar"><div class="row"><div><label>Pipeline</label><select id="pipelineSelect" class="medium"></select></div><button id="addPipeline" class="secondary">Add Pipeline</button><button id="deletePipeline" class="danger">Delete Pipeline</button></div><div class="row"><button id="addPhase">Add Phase</button></div></div>
<div class="band"><label>Description</label><input id="pipelineDescription"/></div>
<div class="band"><div id="phaseList"></div></div>
</section>
<section class="panel" data-panel="prompts"><div class="split"><div class="band"><label>Prompt</label><select id="promptSelect"></select><div class="row"><button id="loadPrompts">Reload</button><button class="primary" id="savePrompt">Save</button><button class="danger" id="deletePrompt">Delete</button></div></div><div class="band"><textarea id="promptText" class="prompt"></textarea></div></div></section>
<section class="panel" data-panel="doctor"><div class="band"><div class="row"><button class="primary" id="runDoctor">Run Doctor</button></div></div><pre class="log" id="doctorLog"></pre></section>
<section class="panel" data-panel="run"><div class="grid"><div class="band"><label>Project Directory</label><input id="projectDir"/><label>Task</label><textarea id="task" style="min-height:130px"></textarea><div class="checkrow"><label><input id="implement" type="checkbox"> include implement</label><label><input id="worktree" type="checkbox"> worktree</label></div><div class="row"><div><label>Pipeline</label><select id="runPipeline" class="medium"></select></div><div><label>Max Attempts</label><input id="maxAttempts" type="number" value="1" class="tiny"/></div><div><label>Requires</label><input id="requires" placeholder="image" class="small"/></div></div><div class="row"><button id="dryRun">Dry Run</button><button class="primary" id="startRun">Start Run</button></div></div><pre class="log" id="runLog"></pre></div></section>
<section class="panel" data-panel="outputs"><div class="grid"><div class="band"><label>Project Directory</label><input id="outputsProjectDir"/><div class="row"><button id="refreshRuns">Refresh</button></div><div id="runs" class="list"></div></div><div class="band"><div id="files" class="list"></div></div></div><pre id="preview" class="preview"></pre></section>
<section class="panel" data-panel="advanced"><div class="grid"><div class="band"><label>models.yaml</label><textarea id="modelsYaml" class="yaml"></textarea></div><div class="band"><label>agents.yaml</label><textarea id="agentsYaml" class="yaml"></textarea></div></div><div class="band"><label>pipelines.yaml</label><textarea id="pipelinesYaml" class="yaml"></textarea><div class="row"><button id="saveYaml" class="primary">Save YAML</button></div></div></section>
</main>
</div>
<script>
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let state=null,prompts=[],selectedPipeline="",issues=[],issuesLoaded=false,discovery=null;
async function api(p,o={}){const r=await fetch(p,{headers:{"Content-Type":"application/json"},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.statusText);return d}
function setStatus(t,ok){$("#status").textContent=t||"";$("#status").style.color=ok?"#0f766e":"#667085"}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function arr(v){return Array.isArray(v)?v: String(v||"").split(",").map(x=>x.trim()).filter(Boolean)}
function csv(v){return arr(v).join(", ")}
function clone(o){return JSON.parse(JSON.stringify(o))}
function uniqueName(base,used){let n=base,i=2;while(used.includes(n)){n=base+"-"+i;i++}return n}
function tab(t){$$(".nav button").forEach(b=>b.classList.toggle("active",b.dataset.tab===t));$$(".panel").forEach(p=>p.classList.toggle("active",p.dataset.panel===t));const active=$(".nav button.active");$("#title").textContent=active?active.textContent:(t[0].toUpperCase()+t.slice(1))}
async function loadState(){state=await api("/api/state");$("#configDir").textContent=state.configDir;selectedPipeline=selectedPipeline||((state.pipelines[0]||{}).name||"");renderAll();loadIssues().catch(e=>{$("#issueList").innerHTML="<div class='issue warn'><strong>Health checks unavailable</strong><div class='muted'>"+esc(e.message)+"</div></div>"});setStatus("Loaded",true)}
async function saveState(){await api("/api/state",{method:"POST",body:JSON.stringify({models:state.models,agents:state.agents,pipelines:state.pipelines})});await loadState();setStatus("Saved with backup",true)}
async function saveYaml(){await api("/api/config",{method:"POST",body:JSON.stringify({models:$("#modelsYaml").value,agents:$("#agentsYaml").value,pipelines:$("#pipelinesYaml").value})});selectedPipeline="";await loadState();setStatus("YAML saved with backup",true)}
function renderAll(){renderStats();renderPresets();renderRuntimeCards();renderDiscovery();renderModels();renderAgents();renderPipelines();renderRunPipeline();renderAdvanced();renderOverview();renderIssues()}
function renderStats(){$("#modelCount").textContent=state.models.length;$("#agentCount").textContent=state.agents.length;$("#pipelineCount").textContent=state.pipelines.length}
function renderPresets(){$("#modelTemplate").innerHTML=state.presets.models.map(p=>"<option value='"+esc(p.id)+"'>"+esc(p.label)+"</option>").join("");$("#rolePreset").innerHTML=state.presets.roles.map(p=>"<option value='"+esc(p.id)+"'>"+esc(p.label)+"</option>").join("");$("#newAgentModel").innerHTML=modelOptions("")}
function modelOptions(sel){return state.models.map(m=>"<option value='"+esc(m.alias)+"' "+(m.alias===sel?"selected":"")+">"+esc(m.alias)+"</option>").join("")}
function roleOptions(sel){return state.presets.roles.map(p=>"<option value='"+esc(p.id)+"' "+(p.id===sel?"selected":"")+">"+esc(p.label)+"</option>").join("")+"<option value='custom' "+(sel==="custom"?"selected":"")+">Custom</option>"}
function runtimeOptions(sel){return (state.runtimes||[]).map(r=>"<option value='"+esc(r.id)+"' "+((sel||"cline")===r.id?"selected":"")+">"+esc(r.label)+" "+(r.installed?"":"(missing)")+"</option>").join("")}
function renderOverview(){const rows=state.pipelines.map(p=>"<span class='pill'>"+esc(p.name)+": "+esc((p.phases||[]).map(x=>x.name).join(" -> "))+"</span>").join("");$("#overviewSummary").innerHTML=rows||"<span class='muted'>No pipelines configured.</span>"}
function renderRuntimeCards(){const el=$("#runtimeCards");if(!el||!state)return;el.innerHTML=(state.runtimes||[]).map(r=>"<span class='badge "+(r.installed?"ok":"warn")+"'>"+esc(r.label)+" · "+(r.installed?"ready":"missing")+" · "+esc(r.maturity)+"</span>").join("")}
async function loadIssues(){issuesLoaded=false;renderIssues();const d=await api("/api/issues");issues=d.issues||[];issuesLoaded=true;renderIssues()}
function renderIssues(){const el=$("#issueList");if(!el)return;if(!issuesLoaded){el.innerHTML="<span class='muted'>Running health checks...</span>";return}if(!issues.length){el.innerHTML="<span class='badge ok'>No blocking setup issues found</span>";return}el.innerHTML=issues.map(i=>"<div class='issue "+esc(i.level)+"'><strong>"+esc(i.level.toUpperCase())+" · "+esc(i.title)+"</strong><div>"+esc(i.detail)+"</div>"+(i.code==="model-id-mismatch"?"<button data-jump='models' style='margin-top:8px'>Fix in Models</button>":"")+"</div>").join("");el.querySelectorAll("[data-jump]").forEach(b=>b.onclick=()=>tab(b.dataset.jump))}
function renderDiscovery(){const els=$$("[data-model-discovery]");if(!els.length)return;let html="<span class='muted'>Run discovery to compare configured model IDs with live endpoints.</span>";if(discovery){const rows=[];for(const endpoint of discovery.endpoints||[]){rows.push("<div class='issue "+(endpoint.ok?"":"warn")+"'><strong>"+esc(endpoint.baseUrl)+"</strong><div class='muted'>"+(endpoint.ok?esc((endpoint.ids||[]).length+" models listed"):esc(endpoint.error||"Endpoint unavailable"))+"</div>"+(endpoint.aliases||[]).map(a=>"<div style='margin-top:6px'>"+esc(a.alias)+": <span class='"+(a.listed?"badge ok":"badge warn")+"'>"+esc(a.modelId)+"</span>"+(a.suggestion?" <button data-fix-model='"+esc(a.alias)+"' data-model-id='"+esc(a.suggestion)+"'>Use "+esc(a.suggestion)+"</button>":"")+"</div>").join("")+"</div>")}html=rows.join("")||"<span class='muted'>No model endpoints configured.</span>"}els.forEach(el=>{el.innerHTML=html;el.querySelectorAll("[data-fix-model]").forEach(b=>b.onclick=()=>{const m=state.models.find(x=>x.alias===b.dataset.fixModel);if(m){m.modelId=b.dataset.modelId;renderModels();renderDiscovery();setStatus("Model ID updated locally. Save Team to write YAML.",true)}})})}
async function discoverModels(){setStatus("Discovering model endpoints...",true);discovery=await api("/api/discover/models");renderDiscovery();setStatus("Model discovery complete",true)}
function renderModels(){const body=$("#modelsBody");body.innerHTML=state.models.map((m,i)=>"<div class='card' data-i='"+i+"'><div class='card-head'><div><div class='card-title'>"+esc(m.alias||"model")+"</div><div class='muted'>"+esc(m.provider||"openai-compatible")+" · ctx "+esc(m.contextWindow||32768)+"</div></div><button class='danger' data-del-model='"+i+"'>Remove</button></div><div class='field-grid'><div><label>Alias</label><input data-f='alias' value='"+esc(m.alias)+"'></div><div><label>Provider</label><input data-f='provider' value='"+esc(m.provider||"openai-compatible")+"'></div><div><label>Base URL</label><input data-f='baseUrl' value='"+esc(m.baseUrl)+"'></div><div><label>Model ID</label><input data-f='modelId' value='"+esc(m.modelId)+"'></div><div><label>API key env</label><input data-f='apiKeyEnv' value='"+esc(m.apiKeyEnv||"")+"' placeholder='NONE / blank for local'></div><div><label>Reasoning</label><select data-f='reasoning'>"+["none","low","medium","high","xhigh"].map(v=>"<option "+((m.reasoning||"medium")===v?"selected":"")+">"+v+"</option>").join("")+"</select></div><div><label>Context window</label><input data-f='contextWindow' type='number' value='"+esc(m.contextWindow||32768)+"'></div><div><label>Output budget</label><input data-f='outputBudget' type='number' value='"+esc(m.outputBudget||4000)+"'></div></div><div class='row' style='margin-top:10px'><label><input type='checkbox' data-mod='text' "+(arr(m.modalities).includes("text")?"checked":"")+"> text</label><label><input type='checkbox' data-mod='image' "+(arr(m.modalities).includes("image")?"checked":"")+"> image / multimodal</label></div></div>").join("");body.querySelectorAll("input[data-f],select[data-f]").forEach(el=>el.oninput=()=>{const card=el.closest(".card");const m=state.models[Number(card.dataset.i)];let v=el.value;if(el.type==="number")v=Number(v);if(el.dataset.f==="apiKeyEnv"&&!v)v=null;m[el.dataset.f]=v;renderRunPipeline();renderRuntimeCards()});body.querySelectorAll("input[data-mod]").forEach(el=>el.onchange=()=>{const card=el.closest(".card");const m=state.models[Number(card.dataset.i)];m.modalities=[...card.querySelectorAll("input[data-mod]:checked")].map(x=>x.dataset.mod)});body.querySelectorAll("[data-del-model]").forEach(b=>b.onclick=()=>{state.models.splice(Number(b.dataset.delModel),1);renderAll()})}
function addModel(){const t=state.presets.models.find(p=>p.id===$("#modelTemplate").value)||state.presets.models[0];const m=clone(t);delete m.id;delete m.label;m.alias=uniqueName(String(t.label||"model").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),state.models.map(x=>x.alias));state.models.push(m);renderAll();setStatus("Model added",true)}
function renderAgents(){const body=$("#agentsBody");body.innerHTML=state.agents.map((a,i)=>"<div class='card' data-i='"+i+"'><div class='card-head'><div><div class='card-title'>"+esc(a.name)+"</div><div class='muted'>"+esc(a.rolePreset||"custom")+" · "+esc(a.phase||"review")+" · "+esc(a.runtime||"cline")+"</div></div><button class='danger' data-del-agent='"+i+"'>Remove</button></div><div class='field-grid'><div><label>Name</label><input data-f='name' value='"+esc(a.name)+"'></div><div><label>Role preset</label><select data-f='rolePreset'>"+roleOptions(a.rolePreset||"custom")+"</select></div><div><label>Runtime</label><select data-f='runtime'>"+runtimeOptions(a.runtime||"cline")+"</select></div><div><label>Model</label><select data-f='model'>"+modelOptions(a.model)+"</select></div><div><label>Default phase</label><input data-f='phase' value='"+esc(a.phase||"review")+"'></div><div><label>Thinking</label><select data-f='thinking'>"+["none","low","medium","high","xhigh"].map(v=>"<option "+((a.thinking||"medium")===v?"selected":"")+">"+v+"</option>").join("")+"</select></div><div><label>Permission mode</label><select data-perm='mode'><option "+(((a.permissions||{}).mode||"read-only")==="read-only"?"selected":"")+">read-only</option><option "+(((a.permissions||{}).mode)==="write"?"selected":"")+">write</option></select></div><div><label>Auto approve</label><label><input type='checkbox' data-bool='autoApprove' "+(a.autoApprove?"checked":"")+"> allow runtime auto-approval</label></div><div><label>Runtime profile</label><input data-f='profile' value='"+esc(a.profile||a.name)+"'></div><div><label>Prompt file</label><input data-f='prompt' value='"+esc(a.prompt||("prompts/"+a.name+".md"))+"'></div></div><label>Role description</label><input data-f='role' value='"+esc(a.role)+"'><label>Tools</label><input data-perm='tools' value='"+esc(csv((a.permissions||{}).tools))+"'><label>MCP/tool access</label><select data-perm='mcp'><option value='profile' "+(((a.permissions||{}).mcp||"profile")==="profile"?"selected":"")+">profile</option><option value='none' "+(((a.permissions||{}).mcp)==="none"?"selected":"")+">none</option></select></div>").join("");body.querySelectorAll("input[data-f],select[data-f]").forEach(el=>el.oninput=()=>{const a=state.agents[Number(el.closest(".card").dataset.i)];a[el.dataset.f]=el.value;if(el.dataset.f==="rolePreset")applyPresetToAgent(a,el.value);renderPipelines()});body.querySelectorAll("input[data-bool]").forEach(el=>el.onchange=()=>{const a=state.agents[Number(el.closest(".card").dataset.i)];a[el.dataset.bool]=el.checked});body.querySelectorAll("[data-perm]").forEach(el=>el.oninput=()=>{const a=state.agents[Number(el.closest(".card").dataset.i)];a.permissions=a.permissions||{};a.permissions[el.dataset.perm]=el.dataset.perm==="tools"?arr(el.value):el.value});body.querySelectorAll("[data-del-agent]").forEach(b=>b.onclick=()=>{state.agents.splice(Number(b.dataset.delAgent),1);renderAll()})}
function applyPresetToAgent(a,id){const p=state.presets.roles.find(x=>x.id===id);if(!p)return;a.rolePreset=p.id;a.role=p.role;a.phase=p.phase;a.thinking=p.thinking;a.autoApprove=p.autoApprove;a.permissions=clone(p.permissions)}
async function addAgent(){const preset=state.presets.roles.find(p=>p.id===$("#rolePreset").value)||state.presets.roles[0];const name=uniqueName(preset.id,state.agents.map(a=>a.name));const agent={name,rolePreset:preset.id,runtime:"cline",role:preset.role,model:$("#newAgentModel").value||((state.models[0]||{}).alias||""),profile:name,phase:preset.phase,prompt:"prompts/"+name+".md",thinking:preset.thinking,autoApprove:preset.autoApprove,permissions:clone(preset.permissions)};state.agents.push(agent);await api("/api/prompts/"+encodeURIComponent(name),{method:"POST",body:JSON.stringify({content:preset.prompt||""})});await loadPrompts();renderAll();setStatus("Role added",true)}
function renderPipelines(){const sel=$("#pipelineSelect");sel.innerHTML=state.pipelines.map(p=>"<option value='"+esc(p.name)+"' "+(p.name===selectedPipeline?"selected":"")+">"+esc(p.name)+"</option>").join("");if(!state.pipelines.some(p=>p.name===selectedPipeline))selectedPipeline=(state.pipelines[0]||{}).name||"";sel.value=selectedPipeline;const p=currentPipeline();$("#pipelineDescription").value=(p&&p.description)||"";const phases=(p&&p.phases)||[];$("#phaseList").innerHTML=phases.map((ph,i)=>phaseRow(ph,i)).join("");wirePhaseRows(phases);renderRunPipeline()}
function phaseRow(ph,i){return "<div class='phase-row' data-i='"+i+"'><div><button class='icon' data-up='"+i+"'>↑</button><button class='icon' data-down='"+i+"'>↓</button></div><div><label>Name</label><input data-ph='name' value='"+esc(ph.name)+"'></div><div><label>Type</label><select data-ph='type'><option value='' "+(!ph.type?"selected":"")+">agent</option><option value='diff' "+(ph.type==="diff"?"selected":"")+">diff</option></select></div><div><label>Mode</label><select data-ph='mode'><option "+((ph.mode||"sequential")==="sequential"?"selected":"")+">sequential</option><option "+(ph.mode==="parallel"?"selected":"")+">parallel</option></select></div><div><label>Agents</label><input data-ph='agents' value='"+esc(csv(ph.agents))+"'></div><div><label>Inputs</label><input data-ph='inputs' value='"+esc(csv(ph.inputs))+"'></div><div><label>Read</label><input type='checkbox' data-ph-bool='readOnly' "+(ph.readOnly!==false?"checked":"")+"></div><div><label>Compact</label><select data-ph='compaction'><option "+((ph.compaction||"basic")==="basic"?"selected":"")+">basic</option><option "+(ph.compaction==="agentic"?"selected":"")+">agentic</option><option "+(ph.compaction==="off"?"selected":"")+">off</option></select></div><div><label>Input B</label><input data-ph='maxInputBytes' type='number' value='"+esc(ph.maxInputBytes||120000)+"'></div><div><label>Words</label><input data-ph='maxOutputWords' type='number' value='"+esc(ph.maxOutputWords||2000)+"'></div><div><button class='danger' data-del-phase='"+i+"'>Remove</button></div></div>"}
function wirePhaseRows(phases){$("#phaseList").querySelectorAll("[data-ph]").forEach(el=>el.oninput=()=>{const ph=phases[Number(el.closest(".phase-row").dataset.i)];let v=el.value;if(["agents","inputs"].includes(el.dataset.ph))v=arr(v);if(["maxInputBytes","maxOutputWords"].includes(el.dataset.ph))v=Number(v);if(el.dataset.ph==="type"&&!v)delete ph.type;else ph[el.dataset.ph]=v});$("#phaseList").querySelectorAll("[data-ph-bool]").forEach(el=>el.onchange=()=>{phases[Number(el.closest(".phase-row").dataset.i)][el.dataset.phBool]=el.checked});$("#phaseList").querySelectorAll("[data-del-phase]").forEach(b=>b.onclick=()=>{phases.splice(Number(b.dataset.delPhase),1);renderPipelines()});$("#phaseList").querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.up);if(i>0){const x=phases.splice(i,1)[0];phases.splice(i-1,0,x);renderPipelines()}});$("#phaseList").querySelectorAll("[data-down]").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.down);if(i<phases.length-1){const x=phases.splice(i,1)[0];phases.splice(i+1,0,x);renderPipelines()}})}
function currentPipeline(){return state.pipelines.find(p=>p.name===selectedPipeline)}
function addPipeline(){const name=uniqueName("custom",state.pipelines.map(p=>p.name));state.pipelines.push({name,description:"Custom pipeline",phases:[]});selectedPipeline=name;renderPipelines()}
function deletePipeline(){const i=state.pipelines.findIndex(p=>p.name===selectedPipeline);if(i>=0){state.pipelines.splice(i,1);selectedPipeline=(state.pipelines[0]||{}).name||"";renderPipelines()}}
function addPhase(){const p=currentPipeline();if(!p)return;p.phases=p.phases||[];p.phases.push({name:"new-phase",mode:"sequential",agents:[],inputs:[],readOnly:true,compaction:"basic",maxInputBytes:120000,maxOutputWords:2000});renderPipelines()}
function renderRunPipeline(){$("#runPipeline").innerHTML="<option value=''>auto</option>"+state.pipelines.map(p=>"<option value='"+esc(p.name)+"'>"+esc(p.name)+"</option>").join("")}
function renderAdvanced(){$("#modelsYaml").value=state.raw.models;$("#agentsYaml").value=state.raw.agents;$("#pipelinesYaml").value=state.raw.pipelines}
async function loadPrompts(){const d=await api("/api/prompts");prompts=d.prompts;$("#promptSelect").innerHTML=prompts.map(p=>"<option>"+esc(p.name)+"</option>").join("");loadPromptText()}
function loadPromptText(){const p=prompts.find(x=>x.name===$("#promptSelect").value);$("#promptText").value=p?p.content:""}
async function savePrompt(){await api("/api/prompts/"+encodeURIComponent($("#promptSelect").value),{method:"POST",body:JSON.stringify({content:$("#promptText").value})});await loadPrompts();setStatus("Prompt saved",true)}
async function deletePrompt(){await api("/api/prompts/"+encodeURIComponent($("#promptSelect").value),{method:"DELETE"});$("#promptText").value="";await loadPrompts();setStatus("Prompt deleted",true)}
async function createMissingPrompts(){for(const a of state.agents){if(!prompts.some(p=>p.name===a.name)){const preset=state.presets.roles.find(p=>p.id===a.rolePreset);await api("/api/prompts/"+encodeURIComponent(a.name),{method:"POST",body:JSON.stringify({content:(preset&&preset.prompt)||""})})}}await loadPrompts();setStatus("Prompt files checked",true)}
function job(action,log,extra={}){log.textContent="";return api("/api/jobs",{method:"POST",body:JSON.stringify(extra.action?extra:{action,...extra})}).then(({id})=>{const es=new EventSource("/api/jobs/"+id+"/events");es.addEventListener("output",e=>{log.textContent+=JSON.parse(e.data);log.scrollTop=log.scrollHeight});es.addEventListener("done",e=>{const d=JSON.parse(e.data);log.textContent+="\\n[done] "+d.status+" exit="+d.exitCode+"\\n";es.close()})})}
async function refreshRuns(){const p=$("#outputsProjectDir").value||$("#projectDir").value;const d=await api("/api/runs?projectDir="+encodeURIComponent(p));$("#runs").innerHTML="";d.runs.forEach(r=>{const b=document.createElement("button");b.textContent=r.name+"  "+new Date(r.modifiedAt).toLocaleString();b.onclick=()=>selectRun(p,r.name);$("#runs").appendChild(b)})}
async function selectRun(p,id){const d=await api("/api/runs/"+encodeURIComponent(id)+"/files?projectDir="+encodeURIComponent(p));$("#files").innerHTML="";d.files.forEach(f=>{const b=document.createElement("button");b.textContent=f.name+" ("+f.size+" B)";b.onclick=()=>loadFile(p,id,f.name);$("#files").appendChild(b)})}
async function loadFile(p,id,f){const d=await api("/api/runs/"+encodeURIComponent(id)+"/file?projectDir="+encodeURIComponent(p)+"&file="+encodeURIComponent(f));$("#preview").textContent=d.content}
function runOptions(action){return{action,projectDir:$("#projectDir").value,task:$("#task").value,implement:$("#implement").checked,worktree:$("#worktree").checked,maxAttempts:$("#maxAttempts").value,requires:$("#requires").value,pipeline:$("#runPipeline").value}}
function wire(){$$(".nav button").forEach(b=>b.onclick=()=>tab(b.dataset.tab));$$("[data-jump]").forEach(b=>b.onclick=()=>tab(b.dataset.jump));$("#reload").onclick=()=>{loadState();loadPrompts()};$("#saveState").onclick=()=>saveState().catch(e=>setStatus(e.message,false));$("#saveYaml").onclick=()=>saveYaml().catch(e=>setStatus(e.message,false));$("#addModel").onclick=addModel;$("#discoverModels").onclick=()=>discoverModels().catch(e=>setStatus(e.message,false));$("#discoverFromSetup").onclick=()=>discoverModels().catch(e=>setStatus(e.message,false));$("#addAgent").onclick=()=>addAgent().catch(e=>setStatus(e.message,false));$("#addPipeline").onclick=addPipeline;$("#deletePipeline").onclick=deletePipeline;$("#addPhase").onclick=addPhase;$("#pipelineSelect").onchange=e=>{selectedPipeline=e.target.value;renderPipelines()};$("#pipelineDescription").oninput=e=>{const p=currentPipeline();if(p)p.description=e.target.value};$("#loadPrompts").onclick=loadPrompts;$("#promptSelect").onchange=loadPromptText;$("#savePrompt").onclick=savePrompt;$("#deletePrompt").onclick=deletePrompt;$("#syncPrompts").onclick=()=>createMissingPrompts().catch(e=>setStatus(e.message,false));$("#runDoctor").onclick=()=>job("doctor",$("#doctorLog"),{action:"doctor"});$("#doctorFromSetup").onclick=()=>{setStatus("Running Doctor checks...",true);loadIssues().then(()=>setStatus("Doctor checks updated",true)).catch(e=>setStatus(e.message,false))};$("#doctorFromModels").onclick=()=>{setStatus("Running Doctor checks...",true);loadIssues().then(()=>setStatus("Doctor checks updated",true)).catch(e=>setStatus(e.message,false))};$("#dryRun").onclick=()=>job("dry-run",$("#runLog"),runOptions("dry-run"));$("#startRun").onclick=()=>job("run",$("#runLog"),runOptions("run"));$("#refreshRuns").onclick=refreshRuns;$("#projectDir").value=localStorage.projectDir||"";$("#outputsProjectDir").value=$("#projectDir").value;$("#projectDir").oninput=()=>{localStorage.projectDir=$("#projectDir").value;$("#outputsProjectDir").value=$("#projectDir").value}}
wire();loadState().catch(e=>setStatus(e.message,false));loadPrompts().catch(e=>setStatus(e.message,false));
</script>
</body>
</html>`;
