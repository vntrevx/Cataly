import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { readSessionUsage } from "../src/usage-session.ts";
import { fakeClock } from "./fakes.ts";
import { usageEntry, usageFixture, USAGE_NOW } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());

test("opt-in native readings feed existing ceilings and final COST once without model or kill commands", async () => {
  const calls: string[][] = [],
    alerts: string[] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  const supervisor = new Supervision(
    {
      stateDir: f.config.stateDir,
      config: f.config,
      clock: fakeClock(USAGE_NOW),
      run,
      alert: (_lane, text) => {
        alerts.push(text);
      },
    },
    { usage: "omp", gitActivity: false, defaults: { tokens: 20, costUsd: 2 } },
  );
  const sweep = await supervisor.sweep(f.lane, "");
  expect(sweep.state).toBe("blocked");
  expect(sweep.usage).toMatchObject({ tokens: 30, costUsd: 3, costBasis: "API price estimate, not a bill" });
  expect(alerts).toEqual(["tokens ceiling reached (20)", "costUsd ceiling reached (2)"]);
  const closed = await supervisor.close(f.lane);
  appendFileSync(f.root, `${JSON.stringify(usageEntry("later", "2026-01-01T12:50:00Z", 20))}\n`);
  expect(await supervisor.close(f.lane)).toEqual(closed);
  const readings = readFileSync(join(f.config.stateDir, "lanes", f.lane.key, "cost.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(readings.filter((r) => r.final)).toHaveLength(1);
  expect(readings.at(-1)).toMatchObject({ final: true, costUsd: 3, costBasis: "API price estimate, not a bill" });
  expect(calls).toEqual([]);
});

test("default supervision does not turn the native collector on", async () => {
  const supervisor = new Supervision(
    {
      stateDir: f.config.stateDir,
      config: f.config,
      clock: fakeClock(USAGE_NOW),
      run: async () => ({ code: 0, out: "", err: "" }),
    },
    { gitActivity: false },
  );
  expect((await supervisor.sweep(f.lane, "")).usage).toMatchObject({ tokens: null, costUsd: null });
  expect(existsSync(join(f.config.stateDir, "lanes", f.lane.key, "usage-cache.json"))).toBe(false);
  expect(existsSync(join(f.config.stateDir, "lanes", f.lane.key, "cost.jsonl"))).toBe(false);
});

test("unchanged journal reuses its numeric snapshot while changed journal rebuilds it", async () => {
  const first = await readSessionUsage(f.root);
  expect(await readSessionUsage(f.root, first)).toBe(first);
  appendFileSync(f.root, `${JSON.stringify(usageEntry("later", "2026-01-01T12:50:00Z", 20))}\n`);
  appendFileSync(f.root, `${JSON.stringify(usageEntry("cache-write", "2026-01-01T12:51:00Z", 2, "model_usage", 7))}\n`);
  const changed = await readSessionUsage(f.root, first);
  expect(changed).not.toBe(first);
  expect(changed.entries).toHaveLength(first.entries.length + 2);
  expect(changed.entries.find((e) => e.id === "cache-write")?.tokens).toBe(22);
});
