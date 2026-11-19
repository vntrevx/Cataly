import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
let dir: string;
let store: ScheduleStore;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-scheduler-delivery-"));
  store = new ScheduleStore(dir);
  now = Date.parse("2026-11-19T00:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const add = () =>
  store.add(
    {
      name: "post",
      cron: "* * * * *",
      tz: "UTC",
      cwd: dir,
      argv: [process.execPath, "-e", "console.log('ready')"],
      deliver: "log",
    },
    now - 60_000,
  );

test("a pending delivery keeps occurrence ownership through the next cron tick", async () => {
  await add();
  let entered!: () => void;
  const delivering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runner = new Scheduler(
    store,
    () => now,
    () => {},
    async () => {
      calls++;
      entered();
      await released;
      return { delivery: "posted", receipts: ["111111"] };
    },
  );
  await runner.open();
  let claimed: string | undefined;
  let observed: ReturnType<ScheduleStore["read"]>["jobs"][number] | undefined;
  let failure: unknown;
  try {
    await runner.tick();
    await delivering;
    claimed = store.read().jobs[0]!.last!.id;
    now += 60_000;
    await runner.tick();
    observed = store.read().jobs[0];
  } finally {
    release();
    try {
      await runner.settle();
    } catch (error) {
      failure = error;
    }
    try {
      await runner.close();
    } catch (error) {
      failure ??= error;
    }
  }
  expect(observed?.last?.id).toBe(claimed);
  expect(observed?.missed).toBe(1);
  expect(calls).toBe(1);
  expect(failure).toBeUndefined();
  expect(store.read().jobs[0]!.last).toMatchObject({ id: claimed, delivery: "posted" });
});

test("remove cannot erase a completion receipt while delivery is still in flight", async () => {
  await add();
  await store.update((document) => {
    document.jobs[0]!.last = {
      id: randomUUID(),
      at: now,
      startedAt: now,
      finishedAt: now,
      status: "exited",
      code: 0,
      delivery: "pending",
    };
  });
  await expect(store.remove("post")).rejects.toThrow("delivery");
  expect(store.read().jobs).toHaveLength(1);
});

test("restart marks uncertain completed delivery unknown instead of posting it again", async () => {
  await add();
  await store.update((document) => {
    document.jobs[0]!.nextAt = now + 60_000;
    document.jobs[0]!.last = {
      id: randomUUID(),
      at: now,
      startedAt: now,
      finishedAt: now,
      status: "exited",
      code: 0,
      delivery: "pending",
    };
  });
  let calls = 0;
  const runner = new Scheduler(
    store,
    () => now,
    () => {},
    async () => {
      calls++;
      return { delivery: "posted" };
    },
  );
  await runner.open();
  try {
    await runner.tick();
    await runner.settle();
  } finally {
    await runner.close();
  }
  expect(calls).toBe(0);
  expect(store.read().jobs[0]!.last!.delivery).toBe("unknown");
  expect(store.read().jobs[0]!.paused).toBe(false);
});

test("a failed post is recorded once, emits one operational warning, and is not replayed", async () => {
  await add();
  let calls = 0;
  const lines: string[] = [];
  const runner = new Scheduler(
    store,
    () => now,
    (line) => lines.push(line),
    async () => {
      calls++;
      throw Error("response lost");
    },
  );
  await runner.open();
  try {
    await runner.tick();
    await runner.settle();
    await runner.tick();
    await runner.settle();
  } finally {
    await runner.close();
  }
  expect(calls).toBe(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("SCHEDULE_ERROR ");
  expect(store.read().jobs[0]!.last).toMatchObject({
    status: "exited",
    delivery: "unknown",
    deliveryError: "Error: response lost",
  });
});
