import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isProcessAlive } from "./fs-utils.js";
import { validateLaneKey } from "./lanes.js";

export type ResourceLockEntry = {
  readonly name: string;
  readonly lane: string;
  readonly pid: number;
  readonly priority: number;
  readonly acquiredAt: string;
  readonly note?: string;
};

const LOCK_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class SharedLocks {
  readonly dir: string;

  constructor(readonly stateDir: string) {
    this.dir = join(stateDir, "locks");
  }

  lockPath(name: string): string {
    if (!LOCK_NAME.test(name)) throw new Error(`invalid lock name: ${name}`);
    return join(this.dir, `${name}.lock.json`);
  }

  list(): ResourceLockEntry[] {
    if (!existsSync(this.dir)) return [];
    const active: ResourceLockEntry[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".lock.json")) continue;
      const fullPath = join(this.dir, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as ResourceLockEntry;
        if (isProcessAlive(parsed.pid)) {
          active.push(parsed);
        } else {
          // reclaim dead owner
          unlinkSync(fullPath);
        }
      } catch {
        // skip damaged lock
      }
    }
    return active.sort((a, b) => a.name.localeCompare(b.name));
  }

  acquire(name: string, lane: string, priority = 5, note?: string, now = Date.now()): ResourceLockEntry {
    validateLaneKey(lane);
    const path = this.lockPath(name);
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(path)) {
      try {
        const cur = JSON.parse(readFileSync(path, "utf8")) as ResourceLockEntry;
        if (isProcessAlive(cur.pid) && cur.lane !== lane) {
          throw new Error(`lock "${name}" is held by lane "${cur.lane}" (pid ${cur.pid})`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('lock "')) throw err;
      }
    }
    const entry: ResourceLockEntry = {
      name,
      lane,
      pid: process.pid,
      priority,
      acquiredAt: new Date(now).toISOString(),
      ...(note ? { note } : {}),
    };
    atomicWriteFile(path, `${JSON.stringify(entry, null, 2)}\n`);
    return entry;
  }

  release(name: string, lane?: string): boolean {
    const path = this.lockPath(name);
    if (!existsSync(path)) return false;
    if (lane) {
      try {
        const cur = JSON.parse(readFileSync(path, "utf8")) as ResourceLockEntry;
        if (cur.lane !== lane) {
          throw new Error(`lock "${name}" is held by "${cur.lane}", not "${lane}"`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('lock "')) throw err;
      }
    }
    unlinkSync(path);
    return true;
  }
}
