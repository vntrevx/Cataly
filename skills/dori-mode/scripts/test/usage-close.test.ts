import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";
import { usageEntry, usageFixture, USAGE_ID, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
let registry: Registry;
beforeEach(async () => {
  f = usageFixture();
  registry = new Registry(f.config.stateDir);
  await registry.write({ ...f.lane, done: 'command ["usage-close-fixture"]' });
});
afterEach(() => f.done());
const deps = (run: Runner = async () => ({ code: 0, out: "", err: "" })) => ({
  registry,
  run,
  config: { ...f.config, supervision: { ...f.config.supervision, usage: "omp" as const } },
  clock: {
    ...fakeClock(USAGE_NOW),
    now: () => (JSON.parse(readFileSync(registry.path(f.lane.key), "utf8")).closedAt ? USAGE_NOW + 10_000 : USAGE_NOW),
  },
});
const finalCost = () =>
  JSON.parse(
    readFileSync(join(f.config.stateDir, "lanes", f.lane.key, "cost.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1)!,
  );

test("final native COST stops at the committed close time rather than the later collection time", async () => {
  appendFileSync(f.root, `${JSON.stringify(usageEntry("after-close", "2026-01-01T13:00:01Z", 40))}\n`);
  const lane = await registry.read(f.lane.key);
  if (!lane) throw new Error("missing fixture lane");
  const result = await closeLane(deps(), lane, "complete");
  expect(result.closed).toBe(true);
  expect((await registry.read(lane.key))?.closedAt).toBe(new Date(USAGE_NOW).toISOString());
  expect(finalCost()).toMatchObject({ final: true, tokens: 30, costUsd: 3 });
});

test("final native COST uses a rebind committed while checking Done and preserves prior lane spend", async () => {
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2";
  writeUsageSession(join(f.directory, `2026-01-01T12-40-00-000Z_${session}.jsonl`), session, "2026-01-01T12:40:00Z", [
    usageEntry("new-binding", "2026-01-01T12:45:00Z", 7),
  ]);
  const lane = await registry.read(f.lane.key);
  if (!lane) throw new Error("missing fixture lane");
  const run: Runner = async (argv) => {
    if (argv[0] === "usage-close-fixture")
      await registry.update(lane.key, (current) => current && { ...current, session, priorSessions: [USAGE_ID] });
    return { code: 0, out: "", err: "" };
  };
  expect((await closeLane(deps(run), lane, "complete")).closed).toBe(true);
  expect((await registry.read(lane.key))?.session).toBe(session);
  expect(finalCost()).toMatchObject({ final: true, tokens: 45, costUsd: 10 });
});
