import { isAbsolute } from "node:path";
import { ArtifactError } from "./artifact-files.ts";

export type ArtifactVersion = {
  readonly sha256: string;
  readonly size: number;
  readonly realPath: string;
  readonly title: string;
  readonly visibility: "private" | "public";
  readonly url: string | null;
  readonly at: string;
};
export type ArtifactReceipt = {
  readonly sha256: string;
  readonly reference: string;
  readonly at: string;
  readonly kind: "operator-reported";
};
export type Artifact = {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly versions: readonly ArtifactVersion[];
  readonly receipts: readonly ArtifactReceipt[];
};
export const artifactText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
export const artifactHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const path = (v: unknown): v is string => artifactText(v, 32768) && isAbsolute(v);
const fields = (v: Record<string, unknown>, names: string): boolean =>
  Object.keys(v).sort().join(",") === names.split(" ").sort().join(",");
const publicUrl = (v: unknown): boolean => {
  if (typeof v !== "string" || /[\p{Cc}\p{Cf}]/u.test(v)) return false;
  try {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.href.includes("?") &&
      !u.href.includes("#")
    );
  } catch {
    return false;
  }
};
const version = (v: unknown): v is ArtifactVersion =>
  record(v) &&
  fields(v, "sha256 size realPath title visibility url at") &&
  artifactHash(v["sha256"]) &&
  typeof v["size"] === "number" &&
  Number.isSafeInteger(v["size"]) &&
  v["size"] >= 0 &&
  path(v["realPath"]) &&
  artifactText(v["title"], 200) &&
  time(v["at"]) &&
  (v["visibility"] === "private" ? v["url"] === null : v["visibility"] === "public" && publicUrl(v["url"]));
const receipt = (v: unknown): v is ArtifactReceipt =>
  record(v) &&
  fields(v, "sha256 reference at kind") &&
  artifactHash(v["sha256"]) &&
  artifactText(v["reference"], 2000) &&
  time(v["at"]) &&
  v["kind"] === "operator-reported";
const artifact = (v: unknown): v is Artifact => {
  if (
    !record(v) ||
    !fields(v, "id path createdAt versions receipts") ||
    typeof v["id"] !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v["id"]) ||
    !path(v["path"]) ||
    !time(v["createdAt"])
  )
    return false;
  const versions = v["versions"],
    receipts = v["receipts"];
  if (
    !Array.isArray(versions) ||
    !versions.length ||
    !versions.every(version) ||
    !Array.isArray(receipts) ||
    !receipts.every(receipt)
  )
    return false;
  if (versions[0]?.at !== v["createdAt"]) return false;
  const seen = new Set<string>();
  return receipts.every((r) => {
    const identity = JSON.stringify([r.sha256, r.reference]);
    if (!versions.some((entry) => entry.sha256 === r.sha256) || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export const parseArtifactManifest = (raw: string, key: string): Artifact[] => {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ArtifactError("artifact index contains invalid JSON; it was not replaced");
  }
  if (
    !record(v) ||
    !fields(v, "schema key artifacts") ||
    v["schema"] !== 1 ||
    v["key"] !== key ||
    !Array.isArray(v["artifacts"]) ||
    !v["artifacts"].every(artifact)
  )
    throw new ArtifactError("artifact index has invalid records; it was not replaced");
  const entries = v["artifacts"];
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    throw new ArtifactError("artifact index has duplicate identities; it was not replaced");
  return entries;
};
