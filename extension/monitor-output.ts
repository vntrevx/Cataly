import { closeSync, mkdtempSync, openSync, rmdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorDelivery } from "./monitor.ts";

/** Raw bytes before LF. A larger line is preserved on disk, never filtered as a fragment. */
const LINE_MAX_BYTES = 64 * 1024;

export class MonitorOutputFile {
  readonly path: string;
  #fd: number | undefined;
  bytes = 0;

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), "omp-dori-monitor-"));
    this.path = join(dir, "output");
    try {
      this.#fd = openSync(this.path, "wx", 0o600);
    } catch (error) {
      rmdirSync(dir);
      throw error;
    }
  }

  write(data: Uint8Array): void {
    if (this.#fd === undefined) throw new Error("monitor output file is closed");
    let offset = 0;
    try {
      while (offset < data.byteLength) {
        const written = writeSync(this.#fd, data, offset, data.byteLength - offset);
        if (written === 0) throw new Error("monitor output write made no progress");
        offset += written;
        this.bytes += written;
      }
    } catch (error) {
      throw new Error(`${String(error)}; partial file=${JSON.stringify(this.path)} (${this.bytes} bytes)`);
    }
  }

  close(): void {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

/** Scan each incoming chunk once; retained partial-line storage does not grow with the input. */
export async function readMonitorOutput(
  stream: ReadableStream<Uint8Array>,
  line: (text: string) => unknown,
  notice: (text: string) => unknown,
  stopped: () => boolean,
  activity?: () => void,
): Promise<void> {
  const buffer = Buffer.alloc(LINE_MAX_BYTES);
  const initialDecoder = new TextDecoder();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let used = 0;
  let first = true;
  let spill: MonitorOutputFile | undefined;
  try {
    for await (const chunk of stream) {
      if (stopped()) return;
      if (chunk.byteLength) activity?.();
      let start = 0;
      while (start < chunk.byteLength) {
        if (stopped()) return;
        const lf = chunk.indexOf(10, start);
        const end = lf < 0 ? chunk.byteLength : lf;
        const part = chunk.subarray(start, end);
        if (!spill && used + part.byteLength > LINE_MAX_BYTES) {
          spill = new MonitorOutputFile();
          spill.write(buffer.subarray(0, used));
          used = 0;
          await notice(
            `line exceeds ${LINE_MAX_BYTES} bytes; filter not evaluated; raw output file=${JSON.stringify(spill.path)} (still writing)`,
          );
        }
        if (spill) {
          spill.write(part);
          if (lf >= 0) {
            spill.write(chunk.subarray(lf, lf + 1));
            spill.close();
            await notice(`oversized line saved: ${spill.bytes} bytes; file=${JSON.stringify(spill.path)}`);
            spill = undefined;
          }
        } else {
          buffer.set(part, used);
          used += part.byteLength;
          if (lf >= 0) {
            // Only the stream's initial BOM is stripped, as with one streaming TextDecoder.
            await line((first ? initialDecoder : decoder).decode(buffer.subarray(0, used)).replace(/\r$/, ""));
            used = 0;
          }
        }
        if (lf >= 0) first = false;
        start = lf < 0 ? chunk.byteLength : lf + 1;
      }
    }
    if (stopped()) return;
    if (spill) {
      spill.close();
      await notice(`oversized line saved: ${spill.bytes} bytes; file=${JSON.stringify(spill.path)}`);
    } else if (used) {
      const tail = (first ? initialDecoder : decoder).decode(buffer.subarray(0, used));
      if (tail) await line(tail);
    }
  } catch (error) {
    const saved = spill ? `; partial file=${JSON.stringify(spill.path)} (${spill.bytes} bytes)` : "";
    throw new Error(`${String(error)}${saved}`);
  } finally {
    spill?.close();
  }
}

type MessageSource = {
  readonly name: string;
  readonly session: string;
  readonly signal: AbortSignal;
  readonly proc: { readonly pid: number };
  stopped: boolean;
};

/** Keep rendered messages bounded, serialized, and admitted only in their originating generation. */
export class MonitorMessages {
  #pending: Array<{ readonly entry: MessageSource; readonly text: string }> = [];
  #timer: Timer | undefined;
  #pendingBytes = 0;
  #generation = new AbortController();
  #flight: Promise<void> | undefined;
  constructor(
    readonly deliver: (content: string, delivery: MonitorDelivery) => unknown,
    readonly currentSession: () => string | undefined,
    readonly stopEntry: (entry: MessageSource) => void,
    readonly batchMs: number,
  ) {}
  get signal(): AbortSignal {
    return this.#generation.signal;
  }
  current(entry: MessageSource): boolean {
    return !entry.signal.aborted && entry.signal === this.signal && entry.session === this.currentSession();
  }
  clear(): void {
    this.#generation.abort();
    this.#generation = new AbortController();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }
  async queue(entry: MessageSource, text: string): Promise<void> {
    if (!this.current(entry)) return;
    let bytes = Buffer.byteLength(text);
    if (bytes > LINE_MAX_BYTES) {
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
      this.#pending.length >= 100 ||
      this.#pendingBytes + bytes + (this.#pending.length ? 1 : 0) > LINE_MAX_BYTES
    ) {
      await this.flush();
      if (!this.current(entry)) return;
    }
    this.#pendingBytes += bytes + (this.#pending.length ? 1 : 0);
    this.#pending.push({ entry, text });
    if (this.#pending.length >= 100 || this.#pendingBytes >= LINE_MAX_BYTES) await this.flush();
    else
      this.#timer ??= setTimeout(() => {
        void this.flush().catch((error: unknown) => console.error("monitor flush failed", error));
      }, this.batchMs);
  }

  async flush(): Promise<void> {
    const signal = this.#generation.signal;
    while (this.#flight) {
      await this.#flight;
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const lines = this.#pending.filter(({ entry }) => this.current(entry));
    this.#pending = [];
    this.#pendingBytes = 0;
    if (lines.length === 0) return;
    const first = lines[0]!.entry;
    const delivery: MonitorDelivery = {
      session: first.session,
      signal: first.signal,
      isCurrent: () => this.current(first),
    };
    const done = (async () => {
      try {
        await this.deliver(lines.map(({ text }) => text).join("\n"), delivery);
      } catch (error) {
        if (delivery.signal.aborted && error === delivery.signal.reason) return;
        if (!delivery.isCurrent()) {
          console.error("monitor delivery failed after session invalidation", error);
          return;
        }
        const entries = [...new Set(lines.map(({ entry }) => entry))];
        for (const entry of entries) this.stopEntry(entry);
        const notice = `[monitor] delivery failed for name=${JSON.stringify(first.name.slice(0, 256))}; stopped ${entries.length} monitor(s); raw output may be incomplete: ${String(error).slice(0, 2048)}`;
        try {
          if (delivery.isCurrent()) await this.deliver(notice, delivery);
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
