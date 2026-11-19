import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_STALE_MS, takeLock } from "../src/checkpoint-lock.ts";
import { Scheduler } from "../src/scheduler.ts";
import { scheduleOutput, ScheduleStore } from "../src/schedule-store.ts";
let dir: string;
let store: ScheduleStore;
let now: number;
const runners: Scheduler[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-scheduler-"));
  store = new ScheduleStore(dir);
  now = Date.parse("2026-11-19T00:00:00Z");
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  rmSync(dir, { recursive: true, force: true });
});
async function add(code: string, deliver: "log" | "wake" = "log") {
  const job = await store.add(
    { name: "job", cron: "* * * * *", tz: "UTC", argv: [process.execPath, "-e", code], cwd: dir, deliver },
    now - 60_000,
  );
  return job;
}
async function start(lines: string[] = []) {
  const runner = new Scheduler(
    store,
    () => now,
    (line) => lines.push(line),
  );
  await runner.open();
  runners.push(runner);
  return runner;
}

test("idle and paused schedules never contend with a held writer lock", async () => {
  for (const name of ["future-a", "future-b", "paused"]) {
    await store.add({ name, cron: "* * * * *", tz: "UTC", argv: ["false"], cwd: dir, deliver: "log" }, now);
  }
  await store.update((document) => {
    document.jobs[2]!.paused = true;
    document.jobs[2]!.nextAt = now - 60_000;
  });
  const runner = await start();
  const before = readFileSync(store.path, "utf8");
  const release = takeLock(store.path + ".lock", Date.now(), (message) => new Error(message));
  if (typeof release === "string") throw new Error(release);
  try {
    for (let i = 0; i < 5; i++) await runner.tick();
    expect(readFileSync(store.path, "utf8")).toBe(before);
    expect(store.read().jobs.every((job) => job.last === undefined)).toBe(true);
  } finally {
    release();
  }
}, 10_000);

test("a stale short writer lock can recover despite a reused live PID", async () => {
  await add("false");
  const release = takeLock(store.path + ".lock", Date.now() - LOCK_STALE_MS - 1, (message) => new Error(message));
  if (typeof release === "string") throw new Error(release);
  try {
    await store.pause("job", true, now);
    expect(store.read().jobs[0]!.paused).toBe(true);
  } finally {
    release();
  }
}, 10_000);

test("claim is durable before execution, output is private, and settled work is not replayed", async () => {
  await add(
    "const fs=require('node:fs');const job=JSON.parse(fs.readFileSync('schedule.json','utf8')).jobs[0]; if(job.last.status!=='running'||job.nextAt<=job.last.at)throw Error('not claimed'); fs.appendFileSync('runs','x'); console.log('done')",
  );
  const runner = await start();
  await runner.tick();
  await runner.settle();
  await runner.tick();
  await runner.settle();
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
  const last = store.read().jobs[0]!.last!;
  expect(last).toMatchObject({ status: "exited", code: 0, delivery: "logged" });
  expect(readFileSync(scheduleOutput(dir, last.id), "utf8")).toBe("done\n");
  expect(statSync(scheduleOutput(dir, last.id)).mode & 0o777).toBe(0o600);
});

test("offline occurrences are counted rather than burst-replayed", async () => {
  await add("require('node:fs').appendFileSync('runs','x')");
  now += 5 * 60_000;
  const runner = await start();
  await runner.tick();
  await runner.settle();
  expect(store.read().jobs[0]!.missed).toBe(5);
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
  expect(store.read().jobs[0]!.last!.at).toBe(now);
});

test("a busy foreground job skips new occurrences without overlapping", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      began();
      return new Response("ok");
    },
  });
  try {
    await add(
      "require('node:fs').appendFileSync('runs','x'); await fetch('http://127.0.0.1:" +
        server.port +
        "/'); await Bun.sleep(250)",
    );
    const runner = await start();
    await runner.tick();
    await started;
    now += 2 * 60_000;
    await runner.tick();
    await runner.settle();
    expect(store.read().jobs[0]!.missed).toBe(2);
    expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
  } finally {
    server.stop(true);
  }
});

test("a second scheduler cannot recover or run the live owner's jobs", async () => {
  await add("console.log('one')");
  const first = await start();
  const second = new Scheduler(store, () => now);
  await expect(second.open()).rejects.toThrow("another scheduler");
  await first.tick();
  await first.settle();
  expect(store.read().jobs[0]!.last!.code).toBe(0);
});

test("an interrupted claim pauses conservatively without signalling its recorded PID", async () => {
  await add("throw Error('must not replay')");
  await store.update((document) => {
    document.jobs[0]!.last = {
      id: randomUUID(),
      at: now,
      startedAt: now,
      pid: process.pid,
      status: "running",
      delivery: "pending",
    };
  });
  const runner = await start();
  await runner.tick();
  await runner.settle();
  const job = store.read().jobs[0]!;
  expect(job).toMatchObject({ paused: true, last: { status: "interrupted", delivery: "unknown", pid: process.pid } });
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  await expect(store.pause("job", false, now)).rejects.toThrow("--ack-interrupted");
  await store.pause("job", false, now, true);
  expect(store.read().jobs[0]!.nextAt).toBeGreaterThan(now);
});

test("oversized output stays complete on disk instead of becoming a huge wake", async () => {
  const lines: string[] = [];
  await add("process.stdout.write('x'.repeat(100000)); process.stderr.write('END')", "wake");
  const runner = await start(lines);
  await runner.tick();
  await runner.settle();
  const last = store.read().jobs[0]!.last!;
  expect(statSync(scheduleOutput(dir, last.id)).size).toBe(100003);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("exceeds 64 KiB");
  expect(lines[0]!.length).toBeLessThan(2000);
});

test("explicit shutdown stops the owned child and records its actual termination", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      began();
      return new Response("ok");
    },
  });
  try {
    await add("await fetch('http://127.0.0.1:" + server.port + "/'); setInterval(()=>{}, 1000)");
    const runner = await start();
    await runner.tick();
    await started;
    await runner.close();
    expect(store.read().jobs[0]!.last!.status).toBe("exited");
    expect(store.read().jobs[0]!.last!.signal).toBe("SIGTERM");
  } finally {
    server.stop(true);
  }
});
