import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MessengerError } from "./http.ts";

/** The caller validates the identity and serializes its own versioned state. */
export const privateStateFile = (dir: string, id: string, label: string) => {
  const path = join(dir, `${id}.json`);
  const privateFile = (stat: Stats) => {
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)
      throw new MessengerError(`${label} must be a private regular file owned by this user`, 0);
  };
  const directory = () => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error();
      return stat;
    } catch {
      throw new MessengerError(`${label} directory must be private (0700) and owned by this user`, 0);
    }
  };
  const syncDirectory = () => {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  directory();
  return {
    path,
    checkWritable(): void {
      const { mode } = directory();
      try {
        if ((mode & 0o700) !== 0o700) throw new Error();
        accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
        syncDirectory();
      } catch {
        throw new MessengerError(`${label} directory must allow owner read, write, search and sync`, 0);
      }
    },
    read(): string | undefined {
      directory();
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw new MessengerError(`${label} is unreadable; use a private regular file owned by this user`, 0);
      }
      try {
        privateFile(fstatSync(fd));
        return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    },
    write(value: string): void {
      directory();
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing) privateFile(existing);
      const temporary = join(dir, `.${id}.${process.pid}.${randomUUID()}.tmp`);
      let fd: number | undefined;
      let created = false;
      try {
        fd = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        writeFileSync(fd, value);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
        created = false;
        syncDirectory();
      } catch {
        throw new MessengerError(`${label} could not be saved; check state directory ownership and space`, 0);
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (created) unlinkSync(temporary);
      }
    },
  };
};
