import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hasControl, object } from "./config.ts";
import { parseDeploymentConfig } from "./deployment-config.ts";
import type { DeploymentConfig } from "./deployment-types.ts";
import { MAIN_CI_CHECKS } from "./github-ci.ts";

export type SourceUpdateConfig = {
  version: 1;
  repository: string;
  git: string;
  gh: string;
  credentialHome: string;
  intervalSeconds: number;
  ownerQuietMs: number;
  activityMaxAgeMs: number;
  activityFiles: string[];
  requiredCi: string[];
  deployment: DeploymentConfig;
};

export function sourceRequiredCi(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((name) => typeof name === "string" && name.trim() === name && name && !hasControl(name))
  )
    throw new Error("requiredCi must list nonempty CI job names");
  if (new Set(value).size !== value.length || !MAIN_CI_CHECKS.every((name) => value.includes(name)))
    throw new Error("requiredCi must include check, e2e-herdr and e2e-hc exactly once");
  return value;
}

export function loadSourceUpdateConfig(path: string): SourceUpdateConfig {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("source update config must be an owned protected regular file");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const keys = [
    "version",
    "repository",
    "git",
    "gh",
    "credentialHome",
    "intervalSeconds",
    "ownerQuietMinutes",
    "activityMaxAgeSeconds",
    "activityFiles",
    "requiredCi",
    "deployment",
  ];
  if (!object(value) || value["version"] !== 1 || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("source update config must be version 1 with only documented settings");
  const parsed = parseDeploymentConfig(value["deployment"], dirname(resolve(path)));
  const deployment: DeploymentConfig = { ...parsed, nativeStopMode: parsed.nativeStopMode ?? "ui" };
  if (deployment.nativeStopMode !== "ui") throw new Error("source updates require idle-only native UI stop");
  const repository = value["repository"] ?? "vntrevx/Cataly";
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("repository must be a GitHub owner/repo");
  const file = (raw: unknown, name: string): string => {
    if (typeof raw !== "string" || !raw.trim() || hasControl(raw)) throw new Error(`${name} must name a real path`);
    return raw === "~"
      ? deployment.home
      : resolve(
          raw.startsWith("~/") ? deployment.home : dirname(resolve(path)),
          raw.startsWith("~/") ? raw.slice(2) : raw,
        );
  };
  const integer = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const n = value[name] ?? fallback;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`invalid source update ${name}`);
    return n;
  };
  const quiet = integer("ownerQuietMinutes", 30, 30, Math.floor(Number.MAX_SAFE_INTEGER / 60_000));
  const rawFiles = value["activityFiles"];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0)
    throw new Error("activityFiles must name every active inbound receiver");
  const activityFiles = rawFiles.map((item) => file(item, "activityFiles"));
  if (
    new Set(activityFiles).size !== activityFiles.length ||
    activityFiles.some((item) => {
      const rel = relative(deployment.stateDir, item);
      return !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    })
  )
    throw new Error("activityFiles must be distinct paths inside deployment.stateDir");
  return {
    version: 1,
    repository,
    deployment,
    git: file(value["git"] ?? Bun.which("git"), "git"),
    gh: file(value["gh"] ?? Bun.which("gh"), "gh"),
    credentialHome: file(value["credentialHome"] ?? deployment.home, "credentialHome"),
    intervalSeconds: integer("intervalSeconds", 86_400, 60, 86_400),
    ownerQuietMs: quiet * 60_000,
    activityMaxAgeMs: integer("activityMaxAgeSeconds", 120, 1, 300) * 1000,
    activityFiles,
    requiredCi: sourceRequiredCi(value["requiredCi"] ?? [...MAIN_CI_CHECKS]),
  };
}
