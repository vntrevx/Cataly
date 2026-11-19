import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "../src/schedule-store.ts";
import { nextSchedule, readScheduleDocument, scheduleDestination, ScheduleError } from "../src/schedule-types.ts";
let dir: string;
let store: ScheduleStore;
const at = Date.parse("2026-11-19T00:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-schedule-state-"));
  store = new ScheduleStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const input = (name = "daily") => ({
  name,
  cron: "0 9 * * *",
  tz: "Asia/Seoul",
  argv: ["bun", "job.ts"],
  cwd: dir,
  deliver: "log" as const,
});

test("cron calculations preserve IANA timezone, OR calendar semantics and DST occurrence identity", () => {
  expect(nextSchedule("0 9 * * *", "Asia/Seoul", at - 1)).toBe(at);
  expect(nextSchedule("0 0 1 * MON", "UTC", at)).toBe(Date.parse("2026-11-23T00:00:00Z"));
  const fall = nextSchedule("30 1 * * *", "America/New_York", Date.parse("2026-11-01T04:00:00Z"));
  expect(fall).toBe(Date.parse("2026-11-01T05:30:00Z"));
  expect(nextSchedule("30 1 * * *", "America/New_York", fall)).toBe(Date.parse("2026-11-02T06:30:00Z"));
  expect(nextSchedule("*/15 * * * *", "America/New_York", Date.parse("2026-11-01T05:45:00Z"))).toBe(
    Date.parse("2026-11-01T06:00:00Z"),
  );
  const spring = nextSchedule("30 2 * * *", "America/New_York", Date.parse("2026-03-08T06:59:00Z"));
  expect(spring).toBeGreaterThanOrEqual(Date.parse("2026-03-08T07:00:00Z"));
  expect(spring).toBeLessThan(Date.parse("2026-03-08T08:00:00Z"));
});

test.each(["61 * * * *", "*/0 * * * *", "0 0 30 2 *", "* * * * * *", "? * * * *"])(
  "invalid or impossible cron is refused: %s",
  (cron) => {
    expect(() => nextSchedule(cron, "UTC", at)).toThrow(ScheduleError);
  },
);

test("the state file is private, duplicate names fail, and concurrent mutations retain every job", async () => {
  await Promise.all([store.add(input("alpha"), at), store.add(input("beta"), at)]);
  expect(
    store
      .read()
      .jobs.map((job) => job.name)
      .sort(),
  ).toEqual(["alpha", "beta"]);
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  await expect(store.add(input("alpha"), at)).rejects.toThrow("already exists");
  await store.pause("alpha", true, at);
  expect(store.read().jobs[0]?.paused).toBe(true);
  await store.pause("alpha", false, at + 86_400_000);
  expect(store.read().jobs[0]?.nextAt).toBeGreaterThan(at + 86_400_000);
  await store.remove("alpha");
  expect(store.read().jobs.map((job) => job.name)).toEqual(["beta"]);
});

test("corrupt and future records are rejected without rewriting or silently dropping their policy", async () => {
  const job = await store.add(input(), at);
  const cases = [
    { version: 2, jobs: [job], adopted: [] },
    { version: 1, jobs: [{ ...job, deliver: "future" }], adopted: [] },
    { version: 1, jobs: [{ ...job, surprise: true }], adopted: [] },
    { version: 1, jobs: [job, job], adopted: [] },
    {
      version: 1,
      jobs: [{ ...job, last: { id: "../outside", at, startedAt: at, status: "running", delivery: "pending" } }],
      adopted: [],
    },
  ];
  for (const value of cases) {
    const raw = JSON.stringify(value);
    writeFileSync(store.path, raw);
    expect(() => store.read()).toThrow(ScheduleError);
    expect(readFileSync(store.path, "utf8")).toBe(raw);
  }
  expect(() => readScheduleDocument(null)).toThrow(ScheduleError);
});

test.each([
  { field: "status", value: ["running"] },
  { field: "status", value: [["running"]] },
  { field: "status", value: ["exited"] },
  { field: "delivery", value: ["pending"] },
  { field: "delivery", value: [["pending"]] },
])("array-valued receipt enums fail closed: %j", async ({ field, value }) => {
  const job = await store.add(input(), at);
  const last = { id: job.id, at, startedAt: at, status: "running", delivery: "pending", [field]: value };
  const raw = JSON.stringify({ version: 1, jobs: [{ ...job, last }], adopted: [] });
  writeFileSync(store.path, raw);
  expect(() => store.read()).toThrow(ScheduleError);
  expect(readFileSync(store.path, "utf8")).toBe(raw);
});

test("post destinations retain platform and explicit thread addressing", () => {
  expect(scheduleDestination("post:discord:123456789")).toEqual({ platform: "discord", to: "123456789" });
  expect(scheduleDestination("post:slack:C123/1700.001")).toEqual({
    platform: "slack",
    to: "C123",
    thread: "1700.001",
  });
  expect(scheduleDestination("post:telegram:-100123/42")).toEqual({
    platform: "telegram",
    to: "-100123",
    thread: "42",
  });
  for (const value of [
    "post:discord:name",
    "post:discord:123456789/42",
    "post:slack:C123/bad",
    "post:telegram:-100/0",
    "post:unknown:x",
  ])
    expect(() => scheduleDestination(value)).toThrow(ScheduleError);
});
