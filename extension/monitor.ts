/**
 * Persistent monitors for the Dori session: a command runs in the background (argv, never a shell) and every
 * stdout/stderr line matching its filter wakes the session. This is the "your monitor tool" the Dori setup
 * expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";
import type { HeadAdmissions } from "./head-admission.ts";
import { MonitorOutputFile, readMonitorOutput } from "./monitor-output";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
/** A burst longer than this is split so one message never grows unbounded. */
const BATCH_MAX_LINES = 100;
const BATCH_MAX_BYTES = 64 * 1024;

type Running = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: RegExp;
  readonly cwd: string;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Session the monitor was started in; its lines are delivered only while that session is current. */
  readonly session: string;
  readonly signal: AbortSignal;
  stopped: boolean;
  admitting: boolean;
};

export type MonitorInfo = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly pid: number;
  readonly cwd: string;
};

export type MonitorDelivery = {
  readonly session: string;
  readonly signal: AbortSignal;
  readonly details?: unknown;
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
  readonly #admissions: HeadAdmissions | undefined;
  readonly #currentSession: () => string | undefined;
  readonly #batchMs: number;

  constructor(
    deliver: Deliver,
    currentSession: () => string | undefined,
    batchMs = BATCH_MS,
    admissions?: HeadAdmissions,
  ) {
    this.#deliver = deliver;
    this.#admissions = admissions;
    this.#currentSession = currentSession;
    this.#batchMs = batchMs;
  }

  start(name: string, argv: readonly string[], filter: string, cwd: string, session: string): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name)) throw new Error(`monitor "${name}" is already running; stop it first`);
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const pattern = new RegExp(filter);
    const proc = Bun.spawn([...argv], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(this.#admissions
        ? {
            env: { ...process.env, DORI_MONITOR_ADMISSION: "1" },
            serialization: "json" as const,
            ipc: (message: unknown) => this.#ipc(entry, message),
          }
        : {}),
    });
    const entry: Running = {
      name,
      argv: [...argv],
      filter: pattern,
      cwd,
      proc,
      session,
      signal: this.#generation.signal,
      stopped: false,
      admitting: false,
    };
    this.#running.set(name, entry);
    void Promise.all([this.#pump(entry, proc.stdout, "stdout"), this.#pump(entry, proc.stderr, "stderr"), proc.exited])
      .then(async ([, , code]) => {
        this.#admissions?.stop(proc.pid);
        if (this.#running.get(name) === entry) this.#running.delete(name);
        if (entry.stopped) return;
        await this.#queue(
          entry,
          `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
        );
      })
      .catch(async (error: unknown) => {
        if (entry.stopped || !this.#current(entry)) return;
        entry.stopped = true;
        entry.proc.kill();
        if (this.#running.get(name) === entry) this.#running.delete(name);
        await this.#queue(
          entry,
          `[monitor] output failed for name=${JSON.stringify(name.slice(0, 256))}${name.length > 256 ? "..." : ""} pid=${proc.pid}; stopped; raw output may be incomplete: ${String(error).slice(0, 2048)}`,
        );
      })
      .catch((error: unknown) => console.error("monitor failure reporting failed", error));
    return { name, argv: entry.argv, filter, cwd, pid: proc.pid };
  }

  stop(name: string): boolean {
    const entry = this.#running.get(name);
    if (!entry) return false;
    this.#admissions?.stop(entry.proc.pid);
    entry.stopped = true;
    entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  list(): MonitorInfo[] {
    return [...this.#running.values()].map((entry) => ({
      name: entry.name,
      argv: entry.argv,
      filter: entry.filter.source,
      pid: entry.proc.pid,
      cwd: entry.cwd,
    }));
  }

  /** Session end: kill every monitor and drop undelivered lines, which belong to the session that is going away. */
  stopAll(): void {
    this.#generation.abort();
    this.#generation = new AbortController();
    this.#admissions?.stop();
    for (const name of [...this.#running.keys()]) this.stop(name);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  #ipc(entry: Running, raw: unknown): void {
    const admissions = this.#admissions;
    if (
      !admissions ||
      raw === null ||
      typeof raw !== "object" ||
      !("protocol" in raw) ||
      raw.protocol !== "dori-head-admission-v1"
    )
      return;
    const fail = () => {
      entry.admitting = false;
      if (entry.stopped) return;
      entry.stopped = true;
      if (entry.proc.exitCode === null && entry.proc.signalCode === null) entry.proc.kill();
      if (this.#running.get(entry.name) === entry) this.#running.delete(entry.name);
      void this.#queue(
        entry,
        ["[monitor]", entry.name, "head admission unresolved; receiver stopped; original input remains queued"].join(
          " ",
        ),
      ).catch((error: unknown) => console.error("monitor admission failure reporting failed", error));
    };
    if (entry.admitting) {
      fail();
      return;
    }
    entry.admitting = true;
    void admissions
      .receive(raw, {
        source: entry.proc.pid,
        session: entry.session,
        accepts: (content) => {
          if (entry.stopped || !this.#current(entry)) throw new Error("inactive head source");
          return content.split("\n").some((line) => entry.filter.test(line));
        },
        deliver: async (content, details) => {
          const isCurrent = () => !entry.stopped && this.#current(entry);
          if (!isCurrent()) throw new Error("inactive head source");
          await this.#flush(async () => {
            if (!isCurrent()) throw new Error("inactive head source");
            const text = content
              .split("\n")
              .map((line) => `[${entry.name}] ${line}`)
              .join("\n");
            await this.#deliver(this.#bounded(entry, text), {
              session: entry.session,
              signal: entry.signal,
              isCurrent,
              details,
            });
          });
          if (!isCurrent()) throw new Error("inactive head source");
        },
      })
      .then((reply) => {
        entry.admitting = false;
        entry.proc.send(reply);
      })
      .catch(fail);
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

  #bounded(entry: Running, text: string): string {
    const bytes = Buffer.byteLength(text);
    if (bytes > BATCH_MAX_BYTES) {
      const output = new MonitorOutputFile();
      try {
        output.write(Buffer.from(text));
      } finally {
        output.close();
      }
      text = `[monitor] message saved for name=${JSON.stringify(entry.name.slice(0, 256))}${entry.name.length > 256 ? "..." : ""} pid=${entry.proc.pid}: ${bytes} bytes; file=${JSON.stringify(output.path)}`;
    }
    return text;
  }

  async #queue(entry: Running, text: string): Promise<void> {
    if (!this.#current(entry)) return;
    text = this.#bounded(entry, text);
    const bytes = Buffer.byteLength(text);
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

  async #flush(admit?: () => Promise<void>): Promise<void> {
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
    if (lines.length === 0 && !admit) return;
    const done = (async () => {
      if (lines.length > 0) {
        const first = lines[0]!.entry;
        const delivery: MonitorDelivery = {
          session: first.session,
          signal: first.signal,
          isCurrent: () => this.#current(first),
        };
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
      }
      await admit?.();
    })();
    // Other writers wait for completion; this caller still receives its own delivery failure.
    const completed = done.catch(() => undefined);
    this.#flight = completed;
    try {
      await done;
    } finally {
      if (this.#flight === completed) this.#flight = undefined;
    }
  }
}

export const MONITOR_DESCRIPTION = [
  "Persistent background monitors for this Dori session.",
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Every line matching the `filter` regular expression wakes this session as a message `[name] line`; lines arriving together are delivered in one message. When a monitor process exits on its own, that is reported the same way; restarting it is your decision.',
  "Lines over 64 KiB are streamed to a private temporary file instead of filtered or truncated. An immediate warning gives its path; completion gives its raw byte count. Batches are limited to 64 KiB including prefixes and separators; an oversized rendered message is preserved in a file too. Read those files for the complete output. They survive monitor stop; remove them only when no longer needed. Storage/read failure stops the monitor and reports potentially incomplete output.",
  'op "stop" kills the monitor `name` and forgets it. op "list" shows running monitors. Names are unique: starting a running name fails.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (herdr restoring it after a restart, or `omp --resume`) every monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");
