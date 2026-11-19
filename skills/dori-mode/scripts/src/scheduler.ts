import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { takeLock } from "./checkpoint-lock.ts";
import { deliverSchedule } from "./schedule-delivery.ts";
import { scheduleOutput, type ScheduleStore } from "./schedule-store.ts";
import { scheduleCron, ScheduleError, type ScheduledJob, type ScheduleRun } from "./schedule-types.ts";

type Delivery = typeof deliverSchedule;
export class Scheduler {
  readonly #stop = new AbortController();
  readonly #children = new Set<Subprocess>();
  readonly #tasks = new Set<Promise<void>>();
  #release: (() => void) | undefined;
  #force: Timer | undefined;
  #failure: unknown;
  constructor(
    readonly store: ScheduleStore,
    readonly now: () => number = Date.now,
    readonly emit: (line: string) => unknown = (line) => console.log(line),
    readonly deliver: Delivery = deliverSchedule,
  ) {}

  async open(): Promise<void> {
    if (this.#release) throw new ScheduleError("scheduler is already open");
    mkdirSync(this.store.stateDir, { recursive: true, mode: 0o700 });
    const held = takeLock(
      join(this.store.stateDir, "scheduler.lock"),
      Date.now(),
      (message) => new ScheduleError("scheduler lock " + message),
      { keepLiveOwner: true },
    );
    if (typeof held === "string") throw new ScheduleError("another scheduler owns this state directory: " + held);
    this.#release = held;
    try {
      await this.store.update((document) => {
        for (const job of document.jobs) {
          if (job.last?.status === "running") {
            job.paused = true;
            job.last = {
              ...job.last,
              status: "interrupted",
              finishedAt: this.now(),
              delivery: "unknown",
              error:
                "scheduler ended without a completion receipt; inspect the recorded PID/output and any orphan before --ack-interrupted resume",
            };
          } else if (job.last?.delivery === "pending") {
            job.last.delivery = "unknown";
            job.last.deliveryError = "previous delivery was interrupted; it is not retried";
          }
        }
      });
    } catch (error) {
      this.#release();
      this.#release = undefined;
      throw error;
    }
  }
  async tick(): Promise<void> {
    if (!this.#release) throw new ScheduleError("scheduler must be opened before ticking");
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#stop.signal.aborted) return;
    for (const seen of this.store.read().jobs) {
      if (this.#stop.signal.aborted) return;
      if (this.#failure !== undefined) throw this.#failure;
      const now = this.now();
      if (seen.paused || seen.nextAt > now) continue;
      const claimed = await this.store.update((document) => {
        const job = document.jobs.find((entry) => entry.id === seen.id);
        if (this.#stop.signal.aborted || !job || job.paused || job.nextAt > now) return;
        const cron = scheduleCron(job.cron, job.tz);
        const advance = (): void => {
          const next = cron.nextRun(new Date(job.nextAt));
          if (!next) throw new ScheduleError("cron has no next occurrence: " + job.name);
          job.nextAt = next.getTime();
        };
        // Bound one recovery tick while counting every skipped occurrence, without replaying stale work.
        let skipped = 0;
        while (job.nextAt <= now - 60_000 && skipped < 1000) {
          advance();
          job.missed++;
          skipped++;
        }
        if (job.nextAt > now || job.nextAt <= now - 60_000) return;
        const at = job.nextAt;
        advance();
        if (job.last?.status === "running" || job.last?.delivery === "pending") {
          job.missed++;
          return;
        }
        job.last = { id: randomUUID(), at, startedAt: now, status: "running", delivery: "pending" };
        return structuredClone(job);
      });
      if (!claimed) continue;
      const task = this.execute(claimed).catch((error: unknown) => {
        this.#failure ??= error;
      });
      this.#tasks.add(task);
      void task.finally(() => this.#tasks.delete(task));
    }
  }
  private async save(job: ScheduledJob, patch: Partial<ScheduleRun>): Promise<void> {
    await this.store.update((document) => {
      const current = document.jobs.find((entry) => entry.id === job.id);
      if (!current || current.last?.id !== job.last!.id)
        throw new ScheduleError("claimed schedule changed before completion: " + job.name);
      current.last = { ...current.last, ...patch };
    });
  }
  private async execute(job: ScheduledJob): Promise<void> {
    if (this.#stop.signal.aborted) return; // The durable claim is recovered as interrupted, never replayed.
    const receipt = job.last!;
    mkdirSync(join(this.store.stateDir, "schedule-runs"), { recursive: true, mode: 0o700 });
    const fd = openSync(scheduleOutput(this.store.stateDir, receipt.id), "wx", 0o600);
    let proc: Subprocess | undefined;
    let code = 127;
    let signal: string | null = null;
    let error: string | undefined;
    try {
      try {
        proc = Bun.spawn(job.argv, { cwd: job.cwd, stdin: "ignore", stdout: fd, stderr: fd });
        this.#children.add(proc);
      } catch (cause) {
        error = String(cause);
        writeSync(fd, error + "\n");
      }
      if (proc) {
        try {
          await this.save(job, { pid: proc.pid });
          code = await proc.exited;
          signal = proc.signalCode === null ? null : String(proc.signalCode);
        } catch (cause) {
          proc.kill("SIGKILL");
          await proc.exited;
          throw cause;
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      if (proc) this.#children.delete(proc);
    }
    const completed: ScheduleRun = {
      ...receipt,
      ...(proc ? { pid: proc.pid } : {}),
      status: "exited",
      finishedAt: this.now(),
      code,
      signal,
      ...(error === undefined ? {} : { error }),
      delivery: "pending",
    };
    await this.save(job, completed);
    let delivered: Pick<ScheduleRun, "delivery" | "receipts" | "deliveryError">;
    try {
      delivered = await this.deliver(this.store.stateDir, job, completed, this.#stop.signal, this.emit);
    } catch (cause) {
      delivered = { delivery: "unknown", deliveryError: String(cause) };
      await this.save(job, delivered);
      if (!this.#stop.signal.aborted)
        await this.emit(
          "SCHEDULE_ERROR " +
            JSON.stringify({
              name: job.name,
              run: receipt.id,
              error: String(cause),
              delivery: "unknown",
              retried: false,
            }),
        );
      return;
    }
    await this.save(job, delivered);
  }
  async settle(): Promise<void> {
    await Promise.all(this.#tasks);
    if (this.#failure !== undefined) throw this.#failure;
  }
  stop(): void {
    if (this.#stop.signal.aborted) return;
    this.#stop.abort(new ScheduleError("scheduler stopped; delivery was not confirmed"));
    for (const child of this.#children) child.kill();
    this.#force = setTimeout(() => {
      for (const child of this.#children) child.kill("SIGKILL");
    }, 5000);
  }
  async close(): Promise<void> {
    this.stop();
    try {
      await Promise.all(this.#tasks);
    } finally {
      clearTimeout(this.#force);
      this.#release?.();
      this.#release = undefined;
    }
    if (this.#failure !== undefined) throw this.#failure;
  }
}
