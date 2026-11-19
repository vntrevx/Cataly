import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { checkLanePolicy, type LanePolicy, PolicyError, policyPatterns } from "./lane-policy.ts";
import { LANE_KEY } from "./registry.ts";

export type PolicySnapshot = {
  readonly version: 1;
  readonly id: string;
  readonly key: string;
  readonly denyBash: readonly string[];
  readonly allowBash: readonly string[];
};
export type BoundPolicy = { readonly file: string; readonly stateDir: string; readonly snapshot: PolicySnapshot };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export const prepareLanePolicy = (
  stateDir: string,
  key: string,
  policy: LanePolicy | undefined,
): BoundPolicy | undefined => {
  if (policy === undefined) return undefined;
  checkLanePolicy(policy);
  if (!LANE_KEY.test(key)) throw new PolicyError("invalid lane policy key");
  const allowBash = Object.entries(policy.perLane ?? {}).flatMap(([glob, entry]) =>
    new RegExp(
      `^${glob
        .split("*")
        .map((p) => p.replaceAll(".", "\\."))
        .join(".*")}$`,
    ).test(key)
      ? entry.allowBash
      : [],
  );
  return {
    file: join(resolve(stateDir), "lanes", key, "policy.json"),
    stateDir: resolve(stateDir),
    snapshot: { version: 1, id: randomUUID(), key, denyBash: [...policy.denyBash], allowBash },
  };
};
export const policyBinding = (policy: BoundPolicy): string =>
  JSON.stringify({ file: policy.file, id: policy.snapshot.id });

export const writeLanePolicy = (policy: BoundPolicy): void => {
  mkdirSync(dirname(policy.file), { recursive: true, mode: 0o700 });
  const tmp = `${policy.file}.${policy.snapshot.id}.tmp`;
  writeFileSync(tmp, JSON.stringify(policy.snapshot), { flag: "wx", mode: 0o600 });
  renameSync(tmp, policy.file);
};

export const readLanePolicy = (binding: string): BoundPolicy => {
  const value = JSON.parse(binding) as { file?: unknown; id?: unknown } | null;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.file !== "string" ||
    !isAbsolute(value.file) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id)
  )
    throw new PolicyError("invalid lane policy binding");
  const file = resolve(value.file);
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as Partial<PolicySnapshot> | null;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    snapshot.version !== 1 ||
    snapshot.id !== value.id ||
    typeof snapshot.key !== "string" ||
    !LANE_KEY.test(snapshot.key)
  )
    throw new PolicyError("lane policy snapshot identity mismatch");
  const stateDir = dirname(dirname(dirname(file)));
  if (join(stateDir, "lanes", snapshot.key, "policy.json") !== file) throw new PolicyError("lane policy path mismatch");
  const denyBash = policyPatterns(snapshot.denyBash, "denyBash");
  const allowBash = policyPatterns(snapshot.allowBash, "allowBash");
  return { file, stateDir, snapshot: { version: 1, id: value.id, key: snapshot.key, denyBash, allowBash } };
};

export const currentLanePolicy = (stateDir: string, key: string): BoundPolicy => {
  if (!LANE_KEY.test(key)) throw new PolicyError("invalid lane policy key");
  const file = join(resolve(stateDir), "lanes", key, "policy.json");
  let value: { id?: unknown } | null;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PolicyError(`lane ${key} has no policy snapshot`);
    if (error instanceof SyntaxError) throw new PolicyError("invalid lane policy snapshot JSON");
    throw error;
  }
  if (typeof value !== "object" || value === null || typeof value.id !== "string")
    throw new PolicyError("invalid lane policy snapshot");
  return readLanePolicy(JSON.stringify({ file, id: value.id }));
};
