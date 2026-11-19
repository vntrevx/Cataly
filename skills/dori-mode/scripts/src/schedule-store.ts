import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "./checkpoint-lock.ts";
import {
  type AdoptedSchedule,
  nextSchedule,
  readScheduleDocument,
  type ScheduleDocument,
  ScheduleError,
  type ScheduledJob,
} from "./schedule-types.ts";

export class ScheduleStore {
  readonly path: string;
  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "schedule.json");
  }
  read(): ScheduleDocument {
    try {
      return readScheduleDocument(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [], adopted: [] };
      if (error instanceof SyntaxError)
        throw new ScheduleError("invalid schedule.json JSON; preserve and repair it before running");
      throw error;
    }
  }
  async update<T>(mutate: (document: ScheduleDocument) => T): Promise<T> {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5000;
    for (;;) {
      const held = takeLock(
        this.path + ".lock",
        Date.now(),
        (message) => new ScheduleError("schedule writer " + message),
      );
      if (typeof held === "string") {
        if (Date.now() >= deadline) throw new ScheduleError("schedule writer busy: " + held);
        await Bun.sleep(10);
        continue;
      }
      try {
        const document = this.read();
        const before = JSON.stringify(document);
        const result = mutate(document);
        const after = JSON.stringify(readScheduleDocument(document));
        if (after !== before) this.write(after);
        return result;
      } finally {
        held();
      }
    }
  }
  private write(text: string): void {
    const temp = this.path + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, text + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
      const dir = openSync(this.stateDir, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  async add(
    input: Pick<ScheduledJob, "name" | "cron" | "tz" | "argv" | "cwd" | "deliver">,
    now: number,
  ): Promise<ScheduledJob> {
    const job: ScheduledJob = {
      ...input,
      id: randomUUID(),
      paused: false,
      nextAt: nextSchedule(input.cron, input.tz, now),
      missed: 0,
    };
    readScheduleDocument({ version: 1, jobs: [job], adopted: [] });
    return this.update((document) => {
      if ([...document.jobs, ...document.adopted].some((entry) => entry.name === input.name))
        throw new ScheduleError("schedule already exists: " + input.name);
      document.jobs.push(job);
      return job;
    });
  }
  async adopt(entry: AdoptedSchedule): Promise<void> {
    readScheduleDocument({ version: 1, jobs: [], adopted: [entry] });
    await this.update((document) => {
      if ([...document.jobs, ...document.adopted].some((other) => other.name === entry.name))
        throw new ScheduleError("schedule already exists: " + entry.name);
      document.adopted.push(entry);
    });
  }
  async pause(name: string, paused: boolean, now: number, acknowledgeInterrupted = false): Promise<void> {
    await this.update((document) => {
      const job = document.jobs.find((entry) => entry.name === name);
      if (!job) throw new ScheduleError("no cron schedule named " + name + "; adopted systemd units are read-only");
      if (!paused && job.last?.status === "running")
        throw new ScheduleError("cannot resume a claimed run before it finishes");
      if (!paused && job.last?.status === "interrupted" && !acknowledgeInterrupted)
        throw new ScheduleError(
          "inspect the interrupted job and possible orphan first, then resume with --ack-interrupted; the claimed occurrence is never retried",
        );
      if (!paused && job.paused) job.nextAt = nextSchedule(job.cron, job.tz, now);
      job.paused = paused;
    });
  }
  async remove(name: string): Promise<void> {
    await this.update((document) => {
      const job = document.jobs.find((entry) => entry.name === name);
      if (job?.last?.status === "running" || job?.last?.delivery === "pending")
        throw new ScheduleError("pause future runs and wait for the claimed run and its delivery before removing it");
      if (!job && !document.adopted.some((entry) => entry.name === name))
        throw new ScheduleError("schedule not found: " + name);
      document.jobs = document.jobs.filter((entry) => entry.name !== name);
      document.adopted = document.adopted.filter((entry) => entry.name !== name);
    });
  }
}

export const scheduleOutput = (stateDir: string, runId: string): string =>
  join(stateDir, "schedule-runs", runId + ".log");
