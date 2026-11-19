import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Per-process native `--config` overlays that pin one lane's model roles and default thinking level. */
export const modelProfileDir = (stateDir: string): string => join(resolve(stateDir), "model-profiles");

/**
 * A fresh empty overlay for exactly one native process start. Pass it as the last `--config` argument: native refuses
 * a missing overlay file, and a later overlay would outrank it. Never reuse or delete it while that process lives.
 */
export const createModelProfileFile = (stateDir: string): string => {
  const dir = modelProfileDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomUUID()}.json`);
  writeFileSync(file, "{}\n", { flag: "wx", mode: 0o600 });
  return file;
};

/** The profile overlay this native process owns: its last config file, inside this Dori state's profile directory. */
export const ownedModelProfileFile = (configFiles: readonly string[], stateDir: string): string | null => {
  const last = configFiles.at(-1);
  return last !== undefined && dirname(resolve(last)) === modelProfileDir(stateDir) ? resolve(last) : null;
};
