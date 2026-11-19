/**
 * Persistent monitors for the Dori session: a command runs in the background (argv, never a shell) and every
 * stdout/stderr line matching its filter wakes the session. This is the "your monitor tool" the Dori setup
 * expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import { MonitorOutputFile, readMonitorOutput } from "./monitor-output";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
/** A burst longer than this is split so one message never grows unbounded. */
const BATCH_MAX_LINES = 100;
const BATCH_MAX_BYTES = 64 * 1024;

type Running = Omit<MonitorInfo, "pid" | "filter"> & {
  readonly filter: RegExp;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Session the monitor was started in; its lines are delivered only while that session is current. */
  readonly session: string;
  readonly onExit: ((exit: MonitorExit) => unknown) | undefined;
  readonly signal: AbortSignal;
  stopped: boolean;
};

export type MonitorInfo = MonitorSpec & {
  readonly pid: number;
  readonly recordId?: string;
};
export type MonitorExit = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: string;
  readonly error?: string;
};

export type MonitorDelivery = {
  readonly session: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
};
type Deliver = (content: string, delivery: MonitorDelivery) => unknown;

export class Monitors {
  readonly #running = new Map<string, Running>();
  #pending: Array<{ readonly entry: Running; readonly text: string }> = [];
  #timer: Timer | undefined;
  #pendingBytes = 0;
  #generation = new AbortController();
  #flight: Promise<void> | undefined;
  readonly #deliver: Deliver;
  readonly #currentSession: () => string | undefined;
  readonly #batchMs: number;

  constructor(deliver: Deliver, currentSession: () => string | undefined, batchMs = BATCH_MS) {
    this.#deliver = deliver;
    this.#currentSession = currentSession;
    this.#batchMs = batchMs;
  }

  start(
    name: string,
    argv: readonly string[],
    filter: string,
    cwd: string,
    session: string,
    options: Pick<MonitorInfo, "mode" | "recordId"> & { onExit?: (exit: MonitorExit) => unknown } = {},
  ): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name))
      throw new Error(`monitor "${name}" is already running or delivering output; stop it first`);
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const pattern = new RegExp(filter);
    const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const entry: Running = {
      name,
      argv: [...argv],
      filter: pattern,
      cwd,
      proc,
      session,
      signal: this.#generation.signal,
      stopped: false,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.recordId ? { recordId: options.recordId } : {}),
      onExit: options.onExit,
    };
    this.#running.set(name, entry);
    void Promise.all([this.#pump(entry, proc.stdout, "stdout"), this.#pump(entry, proc.stderr, "stderr"), proc.exited])
      .then(async ([, , code]) => {
        if (entry.stopped) return;
        await this.#flush();
        if (entry.stopped || !this.#current(entry) || this.#running.get(name) !== entry) return;
        this.#running.delete(name);
        await this.#recordExit(entry, code);
        const current = this.#running.get(name);
        if (entry.stopped || !this.#current(entry) || (current && current !== entry)) return;
        await this.#queue(
          entry,
          `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
        );
      })
      .catch(async (error: unknown) => {
        const current = this.#running.get(name);
        if (entry.stopped || !this.#current(entry) || (current && current !== entry)) return;
        entry.stopped = true;
        entry.proc.kill();
        if (this.#running.get(name) === entry) this.#running.delete(name);
        await this.#recordExit(entry, proc.exitCode, String(error));
        await this.#queue(
          entry,
          `[monitor] output failed for name=${JSON.stringify(name.slice(0, 256))}${name.length > 256 ? "..." : ""} pid=${proc.pid}; stopped; raw output may be incomplete: ${String(error).slice(0, 2048)}`,
        );
      })
      .catch((error: unknown) => console.error("monitor failure reporting failed", error));
    return {
      name,
      argv: entry.argv,
      filter,
      cwd,
      pid: proc.pid,
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.recordId ? { recordId: entry.recordId } : {}),
    };
  }

  stop(name: string): boolean {
    const entry = this.#running.get(name);
    if (!entry) return false;
    entry.stopped = true;
    entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  list(includeExited = false): MonitorInfo[] {
    return [...this.#running.values()]
      .filter((entry) => includeExited || (entry.proc.exitCode === null && entry.proc.signalCode === null))
      .map((entry) => ({
        name: entry.name,
        argv: entry.argv,
        filter: entry.filter.source,
        pid: entry.proc.pid,
        cwd: entry.cwd,
        ...(entry.mode ? { mode: entry.mode } : {}),
        ...(entry.recordId ? { recordId: entry.recordId } : {}),
      }));
  }

  /** Session end: kill every monitor and drop undelivered lines, which belong to the session that is going away. */
  stopAll(): void {
    this.#generation.abort();
    this.#generation = new AbortController();
    for (const name of [...this.#running.keys()]) this.stop(name);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  async #recordExit(entry: Running, code: number | null, error?: string): Promise<void> {
    const signal = entry.proc.signalCode;
    try {
      await entry.onExit?.({
        code,
        signal: signal === null ? null : String(signal),
        at: new Date().toISOString(),
        ...(error === undefined ? {} : { error }),
      });
    } catch (cause) {
      await this.#queue(
        entry,
        `[monitor] exit state was not recorded for name=${JSON.stringify(entry.name.slice(0, 256))}; a future resume may restart it: ${String(cause).slice(0, 2048)}`,
      );
    }
  }

  async #pump(entry: Running, stream: ReadableStream<Uint8Array>, source: string): Promise<void> {
    await readMonitorOutput(
      stream,
      (line) => this.#line(entry, line),
      (notice) => (entry.stopped ? undefined : this.#queue(entry, `[${entry.name}] monitor ${source} ${notice}`)),
      () => entry.stopped || !this.#current(entry),
    );
  }

  #current(entry: Running): boolean {
    return (
      !entry.signal.aborted && entry.signal === this.#generation.signal && entry.session === this.#currentSession()
    );
  }

  async #line(entry: Running, line: string): Promise<void> {
    if (!entry.stopped && entry.filter.test(line)) await this.#queue(entry, `[${entry.name}] ${line}`);
  }

  async #queue(entry: Running, text: string): Promise<void> {
    if (!this.#current(entry)) return;
    let bytes = Buffer.byteLength(text);
    if (bytes > BATCH_MAX_BYTES) {
      const output = new MonitorOutputFile();
      try {
        output.write(Buffer.from(text));
      } finally {
        output.close();
      }
      text = `[monitor] message saved for name=${JSON.stringify(entry.name.slice(0, 256))}${entry.name.length > 256 ? "..." : ""} pid=${entry.proc.pid}: ${bytes} bytes; file=${JSON.stringify(output.path)}`;
      bytes = Buffer.byteLength(text);
    }
    while (
      this.#pending.length >= BATCH_MAX_LINES ||
      this.#pendingBytes + bytes + (this.#pending.length ? 1 : 0) > BATCH_MAX_BYTES
    ) {
      await this.#flush();
      if (!this.#current(entry)) return;
    }
    this.#pendingBytes += bytes + (this.#pending.length ? 1 : 0);
    this.#pending.push({ entry, text });
    if (this.#pending.length >= BATCH_MAX_LINES || this.#pendingBytes >= BATCH_MAX_BYTES) await this.#flush();
    else
      this.#timer ??= setTimeout(() => {
        void this.#flush().catch((error: unknown) => console.error("monitor flush failed", error));
      }, this.#batchMs);
  }

  async #flush(): Promise<void> {
    const signal = this.#generation.signal;
    while (this.#flight) {
      await this.#flight;
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const lines = this.#pending.filter(({ entry }) => this.#current(entry));
    this.#pending = [];
    this.#pendingBytes = 0;
    if (lines.length === 0) return;
    const first = lines[0]!.entry;
    const delivery: MonitorDelivery = {
      session: first.session,
      signal: first.signal,
      isCurrent: () => this.#current(first),
    };
    const done = (async () => {
      try {
        await this.#deliver(lines.map(({ text }) => text).join("\n"), delivery);
      } catch (error) {
        if (delivery.signal.aborted && error === delivery.signal.reason) return;
        if (!delivery.isCurrent()) {
          console.error("monitor delivery failed after session invalidation", error);
          return;
        }
        const entries = [...new Set(lines.map(({ entry }) => entry))];
        for (const entry of entries) {
          entry.stopped = true;
          if (this.#running.get(entry.name) === entry) {
            entry.proc.kill();
            this.#running.delete(entry.name);
          }
        }
        const notice = `[monitor] delivery failed for name=${JSON.stringify(first.name.slice(0, 256))}; stopped ${entries.length} monitor(s); raw output may be incomplete: ${String(error).slice(0, 2048)}`;
        try {
          if (delivery.isCurrent()) await this.#deliver(notice, delivery);
        } catch (reportError) {
          console.error(notice, reportError);
        }
      }
    })();
    this.#flight = done;
    try {
      await done;
    } finally {
      if (this.#flight === done) this.#flight = undefined;
    }
  }
}

export const MONITOR_DESCRIPTION = [
  "Background monitors for this Dori session; persistent by default.",
  'mode "once" records a successful exit (code 0, no signal or output failure) as a durable stop: it stays listed but is not restarted by session resume or /new. Failed or interrupted once jobs retain restore intent; use stop to forget them. Managed source restart waits until every once job finishes successfully or is explicitly stopped.',
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Every line matching the `filter` regular expression wakes this session as a message `[name] line`; lines arriving together are delivered in one message. When a monitor process exits on its own, that is reported the same way; restarting it is your decision.',
  "Lines over 64 KiB are streamed to a private temporary file instead of filtered or truncated. An immediate warning gives its path; completion gives its raw byte count. Batches are limited to 64 KiB including prefixes and separators; an oversized rendered message is preserved in a file too. Read those files for the complete output. They survive monitor stop; remove them only when no longer needed. Storage/read failure stops the monitor and reports potentially incomplete output.",
  'op "stop" kills the monitor `name` and forgets its restore intent and terminal record. op "list" shows running and recorded monitors, their mode, and the last exit code, signal and time. Names are unique: starting a running name fails; an explicit start can replace an exited name.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (herdr restoring it after a restart, or `omp --resume`) every persistent or unfinished once monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");
