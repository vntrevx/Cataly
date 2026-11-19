import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";
import { MessengerError } from "./http.ts";

const privateFile = (stat: Stats) => {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    throw new MessengerError("Discord inbound queue must be a private regular file owned by this user", 0);
  }
};

export const openDiscordQueue = (stateDir: string): Database => {
  const dir = join(stateDir, "discord-inbound");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new MessengerError("Discord inbound queue directory must be private (0700) and owned by this user", 0);
  }
  const path = join(dir, "gateway.sqlite");
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing) privateFile(existing);
  else {
    // Closing an ordinary fd for an existing SQLite inode releases this process's other POSIX locks on it.
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      privateFile(fstatSync(fd));
    } finally {
      closeSync(fd);
    }
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (sidecar) privateFile(sidecar);
  }
  return new Database(path);
};
