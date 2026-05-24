import fs from "node:fs";
import path from "node:path";
import { readText } from "./util.js";

export function runsDir(projectDir = process.cwd()) {
  return path.join(projectDir, ".fleet-runs");
}

export function listRuns(projectDir = process.cwd()) {
  const dir = runsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, modifiedAt: stat.mtime.toISOString(), isDirectory: stat.isDirectory() };
    })
    .filter((run) => run.isDirectory)
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function listRunFiles(projectDir, runId) {
  const dir = path.join(runsDir(projectDir), runId);
  if (!fs.existsSync(dir)) throw new Error(`Run not found: ${runId}`);
  return fs.readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .filter((file) => fs.statSync(file.path).isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readRunFile(projectDir, runId, fileName) {
  if (!fileName || fileName.includes("/") || fileName.includes("..")) {
    throw new Error("Invalid run file name.");
  }
  const file = path.join(runsDir(projectDir), runId, fileName);
  if (!fs.existsSync(file)) throw new Error(`Run file not found: ${fileName}`);
  return readText(file);
}

export function formatRuns(projectDir = process.cwd(), runId = null, fileName = null) {
  if (runId && fileName) return readRunFile(projectDir, runId, fileName);
  if (runId) {
    const files = listRunFiles(projectDir, runId);
    return [`Run: ${runId}`, ...files.map((file) => `${file.name}\t${file.size} B\t${file.modifiedAt}`)].join("\n");
  }
  const runs = listRuns(projectDir);
  if (!runs.length) return `No runs found in ${runsDir(projectDir)}`;
  return runs.map((run) => `${run.name}\t${run.modifiedAt}\t${run.path}`).join("\n");
}
