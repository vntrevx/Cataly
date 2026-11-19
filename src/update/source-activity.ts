import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { object } from "./config.ts";
import { saveDeploymentJson } from "./deployment-files.ts";
import { acquireRestartLock, processIdentity, sameProcess } from "./deployment-process.ts";
import type { ProcessIdentity } from "./deployment-types.ts";

export class InboundActivityError extends Error {}
export type InboundActivityRecord = {
  version: 1;
  platform: "discord" | "telegram" | "slack";
  process: ProcessIdentity;
  quietSince: number;
  healthyAt: number;
  updatedAt: number;
  available: boolean;
};

function owned(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new InboundActivityError("Inbound activity must use an owned protected file and directory");
}

/** Contains no message text, IDs, tokens or session transcript data. */
function readRecord(path: string): InboundActivityRecord {
  owned(dirname(path), true);
  owned(path);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const p = object(value) ? value["process"] : undefined;
  if (
    !object(value) ||
    value["version"] !== 1 ||
    !["discord", "telegram", "slack"].includes(String(value["platform"])) ||
    typeof value["available"] !== "boolean" ||
    !object(p) ||
    typeof p["pid"] !== "number" ||
    !Number.isSafeInteger(p["pid"]) ||
    p["pid"] <= 0 ||
    typeof p["startTicks"] !== "string" ||
    !/^\d+$/.test(p["startTicks"]) ||
    typeof p["bootId"] !== "string" ||
    !p["bootId"] ||
    typeof p["executable"] !== "string" ||
    !isAbsolute(p["executable"]) ||
    typeof p["imageDev"] !== "string" ||
    !/^\d+$/.test(p["imageDev"]) ||
    typeof p["imageIno"] !== "string" ||
    !/^\d+$/.test(p["imageIno"]) ||
    ["quietSince", "healthyAt", "updatedAt"].some(
      (key) => typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0,
    )
  )
    throw new InboundActivityError("Inbound activity record is incomplete");
  return value as InboundActivityRecord;
}

function assertWriter(path: string, identity: ProcessIdentity): void {
  const lock = `${path}.lock`;
  owned(lock, true);
  owned(join(lock, "owner.json"));
  const holder: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  const keys = ["pid", "startTicks", "bootId", "executable", "imageDev", "imageIno"] as const;
  if (!object(holder) || !keys.every((key) => holder[key] === identity[key]) || !sameProcess(identity))
    throw new InboundActivityError("Inbound activity writer is no longer current");
}

export function readInboundActivity(path: string): InboundActivityRecord {
  const record = readRecord(path);
  assertWriter(path, record.process);
  return record;
}

/** Opt-in telemetry is a required safety signal: a write error fails the receiver without advancing its cursor. */
export function inboundActivity(
  path: string | undefined,
  platform: InboundActivityRecord["platform"],
  now: () => number = Date.now,
): { received(): void; healthy(): void; unavailable(): void; close(): void } | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) throw new InboundActivityError("--activity-file must be an absolute path");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  owned(dirname(path), true);
  if (lstatSync(path, { throwIfNoEntry: false })) readRecord(path);
  const identity = processIdentity(process.pid);
  if (!identity) throw new InboundActivityError("Inbound process identity is unavailable");
  const release = acquireRestartLock({ restartLock: `${path}.lock` });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    try {
      release();
    } catch (error) {
      throw new InboundActivityError("Inbound activity lease release failed", { cause: error });
    }
  };
  const record: InboundActivityRecord = {
    version: 1,
    platform,
    process: identity,
    quietSince: now(),
    healthyAt: 0,
    updatedAt: now(),
    available: false,
  };
  const publish = (heartbeat?: number): void => {
    if (closed) throw new InboundActivityError("Inbound activity writer is closed");
    try {
      assertWriter(path, identity);
      owned(dirname(path), true);
      if (lstatSync(path, { throwIfNoEntry: false })) owned(path);
      if (heartbeat !== undefined) {
        const pulse = `${path}.heartbeat`;
        if (lstatSync(pulse, { throwIfNoEntry: false })) owned(pulse);
        saveDeploymentJson(pulse, heartbeat);
      }
      saveDeploymentJson(path, record);
    } catch (error) {
      close();
      if (error instanceof InboundActivityError) throw error;
      throw new InboundActivityError("Inbound activity publication failed", { cause: error });
    }
  };
  publish();
  process.once("exit", close);
  return {
    close,
    received() {
      record.quietSince = record.updatedAt = now();
      publish();
    },
    healthy() {
      const at = now();
      if (!record.available) record.quietSince = at;
      record.available = true;
      record.healthyAt = record.updatedAt = at;
      publish(at);
    },
    unavailable() {
      record.available = false;
      record.updatedAt = now();
      publish();
    },
  };
}
