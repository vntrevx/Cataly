import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LANE_KEY, RESERVED_LANE_KEY } from "../registry.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import type { verifyDiscordSource } from "./discord-source.ts";
import { MessengerError } from "./http.ts";

type Source = Awaited<ReturnType<typeof verifyDiscordSource>>["identity"];
export type ThreadPatch = {
  readonly name?: string;
  readonly appliedTags?: readonly string[];
  readonly archived?: boolean;
};
export type ThreadAttempt = {
  readonly kind: "create" | "set";
  readonly source: Source;
  readonly lane: string;
  readonly parent: string;
  readonly fingerprint: string;
  readonly at: number;
  readonly state: "pending" | "created" | "confirmed";
  readonly thread?: string;
  readonly message?: string;
  readonly candidate?: string;
  readonly patch?: ThreadPatch;
};

export const threadSourceKey = (source: Source): string => JSON.stringify([source.channelId, source.messageId]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).every((name) => names.includes(name));
const validPatch = (value: unknown): boolean =>
  object(value) &&
  fields(value, ["name", "appliedTags", "archived"]) &&
  Object.keys(value).length > 0 &&
  (value["name"] === undefined ||
    (typeof value["name"] === "string" && value["name"].trim().length > 0 && value["name"].length <= 100)) &&
  (value["archived"] === undefined || typeof value["archived"] === "boolean") &&
  (value["appliedTags"] === undefined ||
    (Array.isArray(value["appliedTags"]) && value["appliedTags"].every(isDiscordSnowflake)));

const validAttempt = (value: unknown): value is ThreadAttempt => {
  if (
    !object(value) ||
    !fields(value, [
      "kind",
      "source",
      "lane",
      "parent",
      "fingerprint",
      "at",
      "state",
      "thread",
      "message",
      "candidate",
      "patch",
    ])
  )
    return false;
  const source = value["source"];
  if (
    !object(source) ||
    !fields(source, ["botId", "ownerId", "channelId", "messageId"]) ||
    ![source["botId"], source["ownerId"], source["channelId"], source["messageId"]].every(isDiscordSnowflake)
  )
    return false;
  if (
    typeof value["lane"] !== "string" ||
    !LANE_KEY.test(value["lane"]) ||
    value["lane"] === RESERVED_LANE_KEY ||
    !isDiscordSnowflake(value["parent"]) ||
    typeof value["fingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["fingerprint"]) ||
    typeof value["at"] !== "number" ||
    !Number.isSafeInteger(value["at"]) ||
    value["at"] < 0
  )
    return false;
  if (
    (value["state"] !== "pending" && value["state"] !== "created" && value["state"] !== "confirmed") ||
    ["thread", "message", "candidate"].some((field) => value[field] !== undefined && !isDiscordSnowflake(value[field]))
  )
    return false;
  if (value["state"] !== "pending" && !isDiscordSnowflake(value["thread"])) return false;
  if (value["candidate"] !== undefined && value["state"] !== "pending") return false;
  if (value["message"] !== undefined && (!isDiscordSnowflake(value["thread"]) || value["kind"] !== "create"))
    return false;
  if (value["kind"] === "create")
    return value["patch"] === undefined && (value["state"] !== "pending" || value["thread"] === undefined);
  return (
    value["kind"] === "set" &&
    value["state"] !== "created" &&
    isDiscordSnowflake(value["thread"]) &&
    validPatch(value["patch"])
  );
};

/** The caller holds @discord-threads across read, write-ahead, HTTP and receipt publication. */
export class DiscordThreadReceipts {
  readonly path: string;
  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "discord-threads.json");
  }

  read(): ThreadAttempt[] {
    if (!existsSync(this.path)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (
        !object(value) ||
        !fields(value, ["version", "attempts"]) ||
        value["version"] !== 1 ||
        !Array.isArray(value["attempts"]) ||
        !value["attempts"].every(validAttempt)
      )
        throw new Error("invalid thread receipts");
      const attempts: ThreadAttempt[] = value["attempts"];
      const identities = new Set<string>();
      const lanes = new Set<string>();
      const threads = new Set<string>();
      for (const attempt of attempts) {
        const identity = JSON.stringify([
          attempt.kind,
          threadSourceKey(attempt.source),
          attempt.kind === "set" ? attempt.thread : null,
        ]);
        if (identities.has(identity)) throw new Error("duplicate thread receipt");
        identities.add(identity);
        if (attempt.kind !== "create") continue;
        if (lanes.has(attempt.lane) || (attempt.thread !== undefined && threads.has(attempt.thread)))
          throw new Error("conflicting thread receipt");
        lanes.add(attempt.lane);
        if (attempt.thread !== undefined) threads.add(attempt.thread);
      }
      return attempts;
    } catch {
      throw new MessengerError("Discord thread receipt state is unreadable; inspect it before any mutation", 0);
    }
  }

  write(attempts: readonly ThreadAttempt[]): void {
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "wx", 0o600);
      try {
        try {
          writeFileSync(fd, `${JSON.stringify({ version: 1, attempts })}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.path);
        const directory = openSync(this.stateDir, "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        rmSync(tmp, { force: true });
      }
    } catch {
      throw new MessengerError(
        "Discord thread receipt could not be saved; keep the original source and do not recreate",
        0,
      );
    }
  }
}
