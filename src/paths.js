import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_DIR = path.resolve(here, "..");
export const HOME = os.homedir();
export const FLEET_DIR = path.join(HOME, ".fleet");
export const CONFIG_DIR = process.env.FLEET_CONFIG_DIR || path.join(HOME, ".config", "fleet");
export const PROMPTS_DIR = path.join(CONFIG_DIR, "prompts");
export const MODELS_FILE = path.join(CONFIG_DIR, "models.yaml");
export const AGENTS_FILE = path.join(CONFIG_DIR, "agents.yaml");
export const PIPELINES_FILE = path.join(CONFIG_DIR, "pipelines.yaml");
export const PROFILES_DIR = process.env.FLEET_HOME || path.join(FLEET_DIR, "profiles", "cline");
export const ENV_FILE = path.join(FLEET_DIR, ".env.fleet");
export const DEFAULT_FLEET_SCRIPT = path.join(HOME, ".local", "bin", "fleet");
export const DEFAULT_FLEET_BACKUP_GLOB = path.join(HOME, ".local", "bin");

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

export function resolveConfigPath(value) {
  if (!value) return value;
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.join(CONFIG_DIR, expanded);
}

export function promptPath(value) {
  if (!value) return null;
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return expanded;
  if (expanded.startsWith("prompts/")) return path.join(CONFIG_DIR, expanded);
  return path.join(PROMPTS_DIR, expanded);
}

export function profileDir(profile) {
  return path.join(PROFILES_DIR, profile);
}
