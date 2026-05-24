import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ENV_FILE } from "./paths.js";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeText(file, text, mode) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
  if (mode) fs.chmodSync(file, mode);
}

export function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return true;
}

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate())
  ].join("") + "-" + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("");
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function unique(values) {
  return [...new Set(values)];
}

export function bytesLimit(text, maxBytes) {
  if (!maxBytes || Buffer.byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text);
  return buf.subarray(0, maxBytes).toString("utf8") + "\n\n[truncated by fleet]\n";
}

export function shellQuote(arg) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${String(arg).replaceAll("'", "'\"'\"'")}'`;
}

export function commandPreview(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(" ");
}

export function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error
  };
}

export function commandExists(cmd) {
  if (!cmd) return false;
  const result = runCapture("bash", ["-lc", "command -v \"$1\"", "bash", cmd]);
  return result.ok && Boolean(result.stdout.trim());
}

export function readEnvValue(name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];
  if (!fs.existsSync(ENV_FILE)) return "";
  const result = runCapture("bash", [
    "-lc",
    'set -a; source "$1" >/dev/null 2>&1 || exit 0; key="$2"; printf "%s" "${!key-}"',
    "bash",
    ENV_FILE,
    name
  ]);
  return result.stdout.trim();
}

export function spawnCollect(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { input, onStdout, onStderr, ...spawnOpts } = opts;
    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", (error) => resolve({ ok: false, status: -1, stdout, stderr, error }));
    child.on("close", (status) => resolve({ ok: status === 0, status, stdout, stderr }));
  });
}

export function listFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .filter(predicate)
    .sort();
}
