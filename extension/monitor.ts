/**
 * Persistent monitors for the Dori session: a command runs in the background (argv, never a shell) and every
 * stdout/stderr line matching its filter wakes the session. This is the "your monitor tool" the Dori setup
 * expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";
import { monitorPolicy } from "../src/update/monitor-policy.ts";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import { MonitorMessages, readMonitorOutput } from "./monitor-output";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
const noticeName = (name: string): string => `${name.slice(0, 256)}${name.length > 256 ? "..." : ""}`;
type Running = Omit<MonitorInfo, "pid" | "filter" | "restartAttempt" | "backoffUntil" | "waiting"> & {
  readonly filter: RegExp;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  readonly session: string;
  readonly onExit: ((exit: MonitorExit) => unknown) | undefined;
  readonly signal: AbortSignal;
  stopped: boolean;
  waiting: boolean;
  restartAttempt: number;
  restartTimer?: Timer | undefined;
  silentTimer?: Timer | undefined;
  backoffUntil?: string | undefined;
  lastData: number;
};

export type MonitorInfo = MonitorSpec & {
  readonly pid: number;
  readonly recordId?: string;
  readonly restartAttempt?: number;
  readonly backoffUntil?: string;
  readonly waiting?: boolean;
};
export type MonitorExit = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: string;
  readonly error?: string;
  readonly restartAttempt?: number;
  readonly exhausted?: boolean;
};

export type MonitorDelivery = {
  readonly session: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
};
type Deliver = (content: string, delivery: MonitorDelivery) => unknown;

export class Monitors {
  readonly #running = new Map<string, Running>();
  readonly #messages: MonitorMessages;
  constructor(deliver: Deliver, currentSession: () => string | undefined, batchMs = BATCH_MS) {
    this.#messages = new MonitorMessages(
      deliver,
      currentSession,
      (entry) => {
        entry.stopped = true;
        if (this.#running.get(entry.name) === entry) this.stop(entry.name);
      },
      batchMs,
    );
  }

  start(
    name: string,
    argv: readonly string[],
    filter: string,
    cwd: string,
    session: string,
    options: Pick<MonitorInfo, "mode" | "restart" | "silentAfterMin" | "recordId" | "restartAttempt"> & {
      onExit?: (exit: MonitorExit) => unknown;
    } = {},
  ): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name))
      throw new Error(`monitor "${name}" is already running, delivering output, or waiting to restart; stop it first`);
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const policy = monitorPolicy(options);
    const attempt = options.restartAttempt ?? 0;
    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > (policy.restart?.max ?? 0))
      throw new Error("invalid daemon restart attempt");
    const pattern = new RegExp(filter);
    const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const entry: Running = {
      name,
      argv: [...argv],
      filter: pattern,
      cwd,
      proc,
      session,
      signal: this.#messages.signal,
      ...policy,
      stopped: false,
      waiting: false,
      lastData: performance.now(),
      restartAttempt: attempt,
      ...(options.recordId ? { recordId: options.recordId } : {}),
      onExit: options.onExit,
    };
    this.#running.set(name, entry);
    this.#observe(entry);
    return this.#info(entry);
  }

  stop(name: string): boolean {
    const entry = this.#running.get(name);
    if (!entry) return false;
    entry.stopped = true;
    clearTimeout(entry.restartTimer);
    clearTimeout(entry.silentTimer);
    if (!entry.waiting) entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  /** Health callers see only live children; lifecycle callers can include pending backoff. */
  list(includeWaiting = false): MonitorInfo[] {
    return [...this.#running.values()]
      .filter((entry) => includeWaiting || !entry.waiting)
      .map((entry) => this.#info(entry));
  }
  stopAll(): void {
    this.#messages.clear();
    for (const name of [...this.#running.keys()]) this.stop(name);
  }
  #info(entry: Running): MonitorInfo {
    return {
      name: entry.name,
      argv: entry.argv,
      filter: entry.filter.source,
      cwd: entry.cwd,
      pid: entry.proc.pid,
      ...monitorPolicy(entry),
      ...(entry.recordId ? { recordId: entry.recordId } : {}),
      ...(entry.mode === "daemon" ? { restartAttempt: entry.restartAttempt } : {}),
      ...(entry.backoffUntil ? { backoffUntil: entry.backoffUntil } : {}),
      ...(entry.waiting ? { waiting: true } : {}),
    };
  }
  #observe(entry: Running): void {
    entry.lastData = performance.now();
    this.#silence(entry);
    const proc = entry.proc;
    const exited = proc.exited.then((code) => {
      entry.waiting = true;
      clearTimeout(entry.silentTimer);
      entry.silentTimer = undefined;
      return code;
    });
    void Promise.all([this.#pump(entry, proc.stdout, "stdout"), this.#pump(entry, proc.stderr, "stderr"), exited])
      .then(([, , code]) => this.#finish(entry, code))
      .catch(async (error: unknown) => {
        const current = this.#running.get(entry.name);
        if (entry.stopped || !this.#messages.current(entry) || (current && current !== entry)) return;
        this.stop(entry.name);
        await this.#recordExit(entry, {
          code: proc.exitCode,
          signal: proc.signalCode === null ? null : String(proc.signalCode),
          at: new Date().toISOString(),
          error: String(error),
          ...(entry.restart
            ? { restartAttempt: entry.restartAttempt, exhausted: entry.restartAttempt >= entry.restart.max }
            : {}),
        });
        await this.#messages.queue(
          entry,
          `[monitor] output failed for name=${JSON.stringify(entry.name.slice(0, 256))}${entry.name.length > 256 ? "..." : ""} pid=${proc.pid}; stopped; raw output may be incomplete: ${String(error).slice(0, 2048)}`,
        );
      })
      .catch((error: unknown) => console.error("monitor failure reporting failed", error));
  }
  async #finish(entry: Running, code: number): Promise<void> {
    if (entry.stopped) return;
    await this.#messages.flush();
    if (entry.stopped || this.#running.get(entry.name) !== entry) return;
    if (!this.#messages.current(entry)) {
      this.stop(entry.name);
      return;
    }
    const restart = entry.restart;
    const retry = restart !== undefined && entry.restartAttempt < restart.max;
    if (retry) entry.restartAttempt++;
    entry.waiting = retry;
    if (!retry) this.#running.delete(entry.name);
    const recorded = await this.#recordExit(entry, {
      code,
      signal: entry.proc.signalCode === null ? null : String(entry.proc.signalCode),
      at: new Date().toISOString(),
      ...(entry.mode === "daemon" ? { restartAttempt: entry.restartAttempt, exhausted: !retry } : {}),
    });
    const current = this.#running.get(entry.name);
    if (entry.stopped || (current && current !== entry)) return;
    if (!this.#messages.current(entry)) {
      if (current === entry) this.stop(entry.name);
      return;
    }
    await this.#messages.queue(
      entry,
      `[${entry.name}] monitor exited (${entry.proc.signalCode ? `signal ${entry.proc.signalCode}` : `code ${code}`}): ${entry.argv.join(" ")}`,
    );
    if (!retry) {
      if (restart)
        await this.#messages.queue(
          entry,
          `[monitor] ${noticeName(entry.name)} restart limit reached (${restart.max}); stopped`,
        );
      return;
    }
    if (entry.stopped || this.#running.get(entry.name) !== entry) return;
    if (!recorded || !this.#messages.current(entry)) {
      this.stop(entry.name);
      return;
    }
    const delay = Math.min(2_147_483_647, restart.backoffSec * 1000 * 2 ** (entry.restartAttempt - 1));
    entry.backoffUntil = new Date(Date.now() + delay).toISOString();
    entry.restartTimer = setTimeout(async () => {
      if (entry.stopped || this.#running.get(entry.name) !== entry) return;
      if (!this.#messages.current(entry)) {
        this.stop(entry.name);
        return;
      }
      entry.restartTimer = undefined;
      entry.backoffUntil = undefined;
      try {
        entry.proc = Bun.spawn([...entry.argv], { cwd: entry.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        entry.waiting = false;
        this.#observe(entry);
        await this.#messages.queue(
          entry,
          `[monitor] ${noticeName(entry.name)} restarted (exit ${code}, attempt ${entry.restartAttempt}/${restart.max})`,
        );
      } catch (error) {
        this.stop(entry.name);
        await this.#recordExit(entry, {
          code: null,
          signal: null,
          at: new Date().toISOString(),
          restartAttempt: entry.restartAttempt,
          exhausted: entry.restartAttempt >= restart.max,
          error: `restart failed: ${String(error)}`,
        });
        await this.#messages.queue(
          entry,
          `[monitor] ${noticeName(entry.name)} restart failed; stopped: ${String(error).slice(0, 2048)}`,
        );
      }
    }, delay);
  }
  async #recordExit(entry: Running, exit: MonitorExit): Promise<boolean> {
    try {
      return (await entry.onExit?.(exit)) !== false;
    } catch (cause) {
      await this.#messages.queue(
        entry,
        `[monitor] exit state was not recorded for name=${JSON.stringify(entry.name.slice(0, 256))}; a future resume may restart it: ${String(cause).slice(0, 2048)}`,
      );
      return false;
    }
  }
  #silence(entry: Running): void {
    if (!entry.silentAfterMin || entry.silentTimer || entry.stopped || entry.waiting) return;
    const threshold = entry.silentAfterMin * 60_000;
    entry.silentTimer = setTimeout(
      async () => {
        entry.silentTimer = undefined;
        if (entry.stopped || entry.waiting || !this.#messages.current(entry)) return;
        if (performance.now() - entry.lastData < threshold) this.#silence(entry);
        else
          await this.#messages.queue(
            entry,
            `[monitor] MONITOR_SILENT ${noticeName(entry.name)} ${entry.silentAfterMin}m`,
          );
      },
      Math.max(1, threshold - (performance.now() - entry.lastData)),
    );
  }
  async #pump(entry: Running, stream: ReadableStream<Uint8Array>, source: string): Promise<void> {
    await readMonitorOutput(
      stream,
      async (line) => {
        if (!entry.stopped && entry.filter.test(line)) await this.#messages.queue(entry, `[${entry.name}] ${line}`);
      },
      async (notice) => {
        if (!entry.stopped) await this.#messages.queue(entry, `[${entry.name}] monitor ${source} ${notice}`);
      },
      () => entry.stopped || !this.#messages.current(entry),
      () => {
        entry.lastData = performance.now();
        this.#silence(entry);
      },
    );
  }
}

export const MONITOR_DESCRIPTION = [
  "Background monitors for this Dori session; persistent by default.",
  'mode "daemon" restarts after an exit with bounded exponential backoff: restart {max: 5, backoffSec: 10} by default, at most 100 retries. Exhaustion is a durable stop. Explicit start creates a fresh retry budget; /new resets only unfinished intent. The retry count survives session resume; session restore starts a new process immediately using the retained count. Pending retries are cancelled on stop or session change. A recording or output failure stops automatic retries.',
  "silentAfterMin opts into one MONITOR_SILENT alert per quiet spell, rearmed by any stdout/stderr bytes, including filtered and partial lines. Silence does not restart or kill the child. Timer intervals must be positive and fit the platform timer range.",
  'mode "once" records a successful exit (code 0, no signal or output failure) as a durable stop: it stays listed but is not restarted by session resume or /new. Failed or interrupted once jobs retain restore intent; use stop to forget them. Managed source restart waits until every once job finishes successfully or is explicitly stopped.',
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Every line matching the `filter` regular expression wakes this session as a message `[name] line`; lines arriving together are delivered in one message. When a monitor process exits on its own, that is reported the same way; non-daemon monitors restart only on your decision or session restore.',
  "Lines over 64 KiB are streamed to a private temporary file instead of filtered or truncated. An immediate warning gives its path; completion gives its raw byte count. Batches are limited to 64 KiB including prefixes and separators; an oversized rendered message is preserved in a file too. Read those files for the complete output. They survive monitor stop; remove them only when no longer needed. Storage/read failure stops the monitor and reports potentially incomplete output.",
  'op "stop" kills the monitor `name` and forgets its restore intent and terminal record. op "list" shows running and recorded monitors, their mode, and the last exit code, signal and time. Names are unique: starting a running name fails; an explicit start can replace an exited name.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (herdr restoring it after a restart, or `omp --resume`) every persistent or unfinished once monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");
