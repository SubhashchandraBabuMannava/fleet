import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, FLEET_DIR, PROFILES_DIR, expandHome } from "./paths.js";

export function resetFleet({ factory = false, yes = false, runs = false, cwd = process.cwd() } = {}) {
  if (!factory || !yes) {
    throw new Error("Factory reset requires both --factory and --yes.");
  }

  const removed = [];
  removePath(CONFIG_DIR, removed);
  removePath(process.env.FLEET_HOME ? PROFILES_DIR : FLEET_DIR, removed);

  if (runs) {
    removePath(path.join(expandHome(cwd), ".fleet-runs"), removed);
  }

  return { removed };
}

function removePath(target, removed) {
  if (!target || !fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}
