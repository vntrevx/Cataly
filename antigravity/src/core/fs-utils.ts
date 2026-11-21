import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const SLEEP_ARRAY =
  typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;

/**
 * Zero-CPU synchronous sleep using Atomics.wait when SharedArrayBuffer is available,
 * with a safe busy-wait fallback if unavailable.
 */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (SLEEP_ARRAY) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
    return;
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // fallback when SharedArrayBuffer/Atomics.wait is unavailable
  }
}

/**
 * Atomic file write via temp file + rename.
 * Retries briefly on Windows transient EPERM/EBUSY when an antivirus or concurrent reader holds a handle.
 */
export function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
          throw err;
        }
        sleepSync(25 * (attempt + 1));
      }
    }
    throw lastErr;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Append a single JSONL record safely. If a previous writer crashed mid-line leaving no trailing newline,
 * inserts a leading newline so the new record remains intact.
 */
export function appendJsonlLine(filePath: string, record: unknown, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a+", mode);
  try {
    const size = fstatSync(fd).size;
    let torn = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      torn = readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    }
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

const STALE_LOCK_MS = 60_000;

export type LockOwnerInfo = {
  pid: number;
  at: string;
  nonce: string;
};

function tryReclaimStaleLock(lockPath: string, now: number): boolean {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwnerInfo>;
    if (typeof parsed.pid === "number" && isProcessAlive(parsed.pid)) {
      return false;
    }
    const age = typeof parsed.at === "string" ? now - Date.parse(parsed.at) : STALE_LOCK_MS + 1;
    if (typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) {
      unlinkSync(lockPath);
      return true;
    }
    if (age >= STALE_LOCK_MS) {
      unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch {
    try {
      const st = statSync(lockPath);
      if (now - st.mtimeMs >= STALE_LOCK_MS) {
        unlinkSync(lockPath);
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }
}

/**
 * Acquire an exclusive file lock with stale PID reclamation and return a release callback.
 */
export function acquireFileLock(lockPath: string, waitMs = 3_000): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const nonce = randomUUID();
  const deadline = Date.now() + waitMs;

  for (;;) {
    const now = Date.now();
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const payload: LockOwnerInfo = { pid: process.pid, at: new Date(now).toISOString(), nonce };
      try {
        writeSync(fd, JSON.stringify(payload));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwnerInfo>;
          if (current.nonce === nonce) {
            unlinkSync(lockPath);
          }
        } catch {
          // already removed or replaced
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      if (tryReclaimStaleLock(lockPath, now)) continue;
      if (Date.now() >= deadline) {
        let holder = "unknown";
        try {
          holder = readFileSync(lockPath, "utf8").slice(0, 120);
        } catch {
          // ignore
        }
        throw new Error(`Lock busy: ${lockPath} (${holder})`);
      }
      sleepSync(25);
    }
  }
}

export function withFileLock<T>(lockPath: string, fn: () => T, waitMs = 3_000): T {
  const release = acquireFileLock(lockPath, waitMs);
  try {
    return fn();
  } finally {
    release();
  }
}

export function readJsonFileOrNull<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function isSingleLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)
  );
}
