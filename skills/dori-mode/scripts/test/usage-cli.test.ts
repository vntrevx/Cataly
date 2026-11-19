import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import type { DoriConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(async () => {
  f = usageFixture();
  await new Registry(f.config.stateDir).write(f.lane);
});
afterEach(() => f.done());
const invoke = async (args: string[], patch: Partial<DoriConfig> = {}) => {
  const config = join(f.dir, "config.json"),
    preload = join(f.dir, "clock.ts");
  writeFileSync(config, JSON.stringify({ ...f.config, ...patch }));
  writeFileSync(preload, `Date.now = () => ${USAGE_NOW};`);
  const child = Bun.spawn(
    [process.execPath, "--preload", preload, resolve(import.meta.dir, "../src/cli.ts"), ...args],
    {
      cwd: f.dir,
      // Preserve the temp-relative session identity while keeping HOME and credentials isolated.
      env: {
        HOME: f.dir,
        TMPDIR: tmpdir(),
        PATH: "/usr/bin:/bin",
        DORI_CONFIG: config,
        DORI_STATE_DIR: f.config.stateDir,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err: err.trim() };
};

test("actual usage CLI groups registered lane intervals by lane, thread and UTC day", async () => {
  for (const [by, group] of [
    ["lane", f.lane.key],
    ["thread", f.lane.thread],
    ["day", "2026-01-01"],
  ]) {
    const result = await invoke(["usage", "--by", by!, "--since", "7d", "--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const value = JSON.parse(result.out);
    expect(value.groups).toEqual([{ group, lanes: [f.lane.key], tokens: 30, costUsd: 3 }]);
    expect(value.lanes[0].costBasis).toBe("API price estimate, not a bill");
    expect(result.out).not.toContain("PRIVATE_TRANSCRIPT_CONTENT");
  }
  const text = await invoke(["usage", f.lane.key]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("main=3 subagents=0");
  const recent = await invoke(["usage", "--since", "0.5h", "--json"]);
  expect(JSON.parse(recent.out).groups[0].tokens).toBe(0);
});

test("actual usage CLI reports overlapping same-session lanes as unknown rather than double-charging", async () => {
  await new Registry(f.config.stateDir).write({ ...f.lane, key: "usage-overlap" });
  const result = await invoke(["usage", "--by", "thread", "--json"]);
  expect(result.code).toBe(0);
  const data = JSON.parse(result.out);
  expect(data.groups[0].costUsd).toBeNull();
  expect(data.groups[0].tokens).toBeNull();
  expect(
    data.lanes.every((lane: { issues: string[] }) =>
      lane.issues.includes("session is shared by overlapping lane intervals"),
    ),
  ).toBe(true);
});

test("actual aggregate CLI keeps healthy lane totals when another collector owns one lane lock", async () => {
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2";
  const busy = { ...f.lane, key: "usage-busy", session };
  writeUsageSession(join(f.directory, `2026-01-01T12-00-00-000Z_${session}.jsonl`), session, "2026-01-01T12:00:00Z", [
    usageEntry("busy", "2026-01-01T12:25:00Z", 4),
  ]);
  await new Registry(f.config.stateDir).write(busy);
  await collectOmpUsage(f.config, busy, USAGE_NOW);
  const lock = takeLock(
    join(f.config.stateDir, "lanes", busy.key, "usage-cache.json.lock"),
    USAGE_NOW,
    (message) => new Error(message),
    { keepLiveOwner: true },
  );
  if (typeof lock === "string") throw new Error(lock);
  try {
    const result = await invoke(["usage", "--json"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out);
    expect(data.groups.find((row: { group: string }) => row.group === f.lane.key).costUsd).toBe(3);
    expect(data.groups.find((row: { group: string }) => row.group === busy.key).costUsd).toBeNull();
    expect(data.lanes.find((lane: { key: string }) => lane.key === busy.key).issues).toContain(
      "usage collection in progress",
    );
  } finally {
    lock();
  }
});

test("actual quota CLI preserves the exact read-only argv and its private cache across subprocesses", async () => {
  const program = join(f.dir, "omp-fixture.ts"),
    log = join(f.dir, "argv.jsonl");
  writeFileSync(
    program,
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log(JSON.stringify({generatedAt: ${USAGE_NOW}, reports: [{provider: "fixture", fetchedAt: ${USAGE_NOW}, limits: [{label: "5h", window: {durationMs: 18000000}, amount: {usedFraction: 0.5}}]}]}));`,
  );
  const patch = { quota: { command: [process.execPath, program] } };
  const first = await invoke(["quota", "--json"], patch);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out).accounts[0].limits[0].usedFraction).toBe(0.5);
  const cached = await invoke(["quota"], patch);
  expect(cached.code).toBe(0);
  expect(cached.out).toContain("50.0%");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(['["usage","--json"]']);
  expect((await invoke(["quota", "--refresh"], patch)).code).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(['["usage","--json"]', '["usage","--json"]']);
});

test("CLI refuses malformed windows, conflicting collectors and quota actions before execution", async () => {
  for (const args of [
    ["usage", "--by", "account"],
    ["usage", "--since", "5m"],
    ["usage", "--since", `${"9".repeat(30)}h`],
    ["usage", "missing-lane"],
  ]) {
    const result = await invoke(args);
    expect(result.code).toBe(1);
    expect(result.err).not.toBe("");
  }
  expect((await invoke(["usage"], { supervision: { usage: "omp", usageArgv: ["external"] } })).code).toBe(1);
  expect((await invoke(["quota"], { quota: { command: ["omp", "usage", "reset"] } })).code).toBe(1);
});
