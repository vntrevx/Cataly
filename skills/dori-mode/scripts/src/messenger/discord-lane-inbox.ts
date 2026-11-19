import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { readPaneState } from "../lane-state.ts";
import { type Lane, Registry, RESERVED_LANE_KEY, statusOf } from "../registry.ts";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { formatDiscordInbound } from "./discord-inbound.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

export type LaneMessage = { id: string; text: string };

export function openDiscordLaneInbox(stateDir: string) {
  const dir = join(stateDir, "discord-lanes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new Error("Discord lane inbox directory must be private and owned by this user");
  const path = join(dir, "inbox.sqlite");
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.uid !== directory.uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0))
      throw new Error("Discord lane inbox files must be private and owned by this user");
  }
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox (session TEXT NOT NULL, channel TEXT NOT NULL, id TEXT NOT NULL, text TEXT,
      PRIMARY KEY (session, channel, id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(session, channel, length(id), id) WHERE text IS NOT NULL;`);
    const insert = db.query("INSERT OR IGNORE INTO inbox(session, channel, id, text) VALUES (?, ?, ?, ?)");
    const acknowledge = db.query("UPDATE inbox SET text=NULL WHERE session=? AND channel=? AND id=?");
    const next = db.query<LaneMessage, [string, string]>(
      "SELECT id,text FROM inbox WHERE session=? AND channel=? AND text IS NOT NULL ORDER BY length(id),id LIMIT 1",
    );
    return {
      add(session: string, message: DiscordInbound) {
        insert.run(session, message.channel, message.message, formatDiscordInbound(message));
      },
      next: (session: string, channel: string) => next.get(session, channel),
      acknowledge: (session: string, channel: string, id: string) => acknowledge.run(session, channel, id),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function uniqueDiscordLane(
  stateDir: string,
  match: (lane: Lane) => boolean,
  allowSharedChannel = false,
): Promise<Lane | undefined> {
  const { lanes } = await new Registry(stateDir).scan();
  const open = lanes.filter((lane) => lane.key !== RESERVED_LANE_KEY && statusOf(lane) !== "closed");
  const matches = open.filter(match);
  const lane = matches[0];
  if (matches.length !== 1 || !lane?.sessionRef) return undefined;
  const { id, runtime } = lane.sessionRef;
  if (
    open.some(
      (other) =>
        other !== lane &&
        ((!allowSharedChannel && other.thread === lane.thread) ||
          (other.sessionRef?.id === id && other.sessionRef.runtime === runtime)),
    )
  )
    return undefined;
  return lane;
}

export function hasDiscordLaneMessages(stateDir: string, session: string, channel: string): boolean {
  if (!existsSync(join(stateDir, "discord-lanes", "inbox.sqlite"))) return false;
  const inbox = openDiscordLaneInbox(stateDir);
  try {
    return inbox.next(session, channel) !== null;
  } finally {
    inbox.close();
  }
}

export function pendingDiscordLane(stateDir: string, lane: Lane): boolean {
  const pane = lane.sessionRef && readPaneState(stateDir, lane.sessionRef.id);
  const native = pane?.role === "lane" && (!lane.session || lane.session === pane.sessionId) ? pane : undefined;
  const session =
    lane.session ?? (native?.discordLaneKey === lane.key || native?.discordLaneReceiver ? native.sessionId : undefined);
  if (!session) return false;
  const channel = lane.thread.startsWith("discord:") ? lane.thread.slice(8) : undefined;
  if (isDiscordSnowflake(channel) && hasDiscordLaneMessages(stateDir, session, channel)) return true;
  const receiver = native?.discordLaneReceiver;
  return receiver !== undefined && hasDiscordLaneMessages(receiver.stateDir, session, receiver.channel);
}

/** Resolve an owner message only when one registered lane owns the exact Discord channel. */
export async function discordLaneTarget(
  stateDir: string,
  channel: string,
): Promise<{ key: string; session: string } | undefined> {
  const lane = await uniqueDiscordLane(stateDir, (item) => item.thread === `discord:${channel}`);
  if (!lane?.sessionRef) return undefined;
  const pane = readPaneState(stateDir, lane.sessionRef.id);
  if (pane?.role !== "lane" || pane.discordLaneInbox !== true) return undefined;
  // A cleanly retired exact session can receive queued work for its next resume. The launch-only
  // hint is weaker and cannot bind a retired or dead process to a lane with no recorded session.
  if (lane.session === pane.sessionId && pane.pid === 0) return { key: lane.key, session: pane.sessionId };
  if (
    pane.pid <= 0 ||
    (lane.session !== pane.sessionId && (lane.session !== undefined || pane.discordLaneKey !== lane.key))
  )
    return undefined;
  try {
    process.kill(pane.pid, 0);
  } catch {
    return undefined;
  }
  return { key: lane.key, session: pane.sessionId };
}
