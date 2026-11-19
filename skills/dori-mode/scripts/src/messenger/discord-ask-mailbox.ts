import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

const RETAIN_MS = 48 * 60 * 60 * 1_000;
const MAX_REPLY_BYTES = 16_384;
const owned = (uid: number) => process.getuid === undefined || uid === process.getuid();
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;

/** Reads only bounded, private regular files, without following the last path component. */
export function readPrivateAskFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat.uid) || (stat.mode & 0o077) !== 0 || stat.size > maxBytes)
      throw new Error("ASK file must be an owned, private regular file within the size limit");
    const bytes = Buffer.allocUnsafe(Math.min(stat.size, maxBytes) + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) return bytes.toString("utf8", 0, size);
      size += count;
      if (size === bytes.length) throw new Error("ASK file grew during the bounded read");
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077) !== 0)
    throw new Error("ASK mailbox directory is not private");
}

function paths(stateDir: string, channel: string, question: string) {
  const root = join(stateDir, "discord-ask-replies");
  return { root, exchange: join(root, `${channel}-${question}`) };
}

/** Publish once, including when a receiver is replaying after a cursor write failure. */
function createFile(dir: string, name: string, text: string): void {
  const temp = join(dir, `.partial-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, join(dir, name));
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    unlinkSync(temp);
  }
}

export type AskReply = { channel: string; message: string; reference: string | null; text: string };

/** Call only after the Discord intake has verified the real owner and channel. */
export function routeDiscordAskReply(stateDir: string, message: AskReply, owner: string): boolean {
  const { channel, reference, message: id, text } = message;
  if (!isDiscordSnowflake(channel) || !isDiscordSnowflake(reference) || !isDiscordSnowflake(id)) return false;
  if (BigInt(id) <= BigInt(reference)) return false;
  const { root, exchange } = paths(stateDir, channel, reference);
  try {
    privateDirectory(root);
    privateDirectory(exchange);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (readPrivateAskFile(join(exchange, "owner"), 24) !== owner) return false;
  const closedPath = join(exchange, "closed");
  if (readPrivateAskFile(closedPath, 1) !== undefined) return true;
  if (Date.now() - lstatSync(exchange).birthtimeMs > RETAIN_MS) return true;
  const answer = JSON.stringify(text);
  if (Buffer.byteLength(answer) > MAX_REPLY_BYTES) throw new Error("Discord ASK reply exceeds the local size limit");
  const name = `reply-${id}`;
  createFile(exchange, name, answer);
  if (readPrivateAskFile(closedPath, 1) !== undefined) rmSync(join(exchange, name), { force: true });
  return true;
}

export function openDiscordAskMailbox(stateDir: string, channel: string, question: string, owner: string) {
  if (![channel, question, owner].every(isDiscordSnowflake)) throw new Error("Invalid Discord ASK mailbox identity");
  const { root, exchange } = paths(stateDir, channel, question);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const cutoff = Date.now() - RETAIN_MS;
  for (const name of readdirSync(root)) {
    if (!/^\d{1,20}-\d{1,20}$/.test(name)) continue;
    const dir = join(root, name);
    const status = lstatSync(dir, { throwIfNoEntry: false });
    if (status?.isDirectory() && owned(status.uid) && status.birthtimeMs < cutoff)
      rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(exchange, { mode: 0o700 });
  createFile(exchange, "owner", owner);
  return {
    replies(seen: ReadonlySet<string>): Array<{ id: string; text: string }> {
      return readdirSync(exchange)
        .filter((name) => /^reply-\d{1,20}$/.test(name))
        .map((name) => name.slice(6))
        .filter((id) => !seen.has(id))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .flatMap((id) => {
          const raw = readPrivateAskFile(join(exchange, `reply-${id}`), MAX_REPLY_BYTES);
          const text: unknown = raw === undefined ? undefined : JSON.parse(raw);
          return typeof text === "string" ? [{ id, text }] : [];
        });
    },
    close(): void {
      createFile(exchange, "closed", "1");
      for (const name of readdirSync(exchange)) {
        if (/^reply-\d{1,20}$/.test(name)) rmSync(join(exchange, name), { force: true });
      }
    },
  };
}
