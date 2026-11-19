import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Registry } from "../src/registry.ts";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_ID, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());
const collect = () => collectOmpUsage(f.config, f.lane, USAGE_NOW);

test("resumed lane charges only its interval and unchanged reads never add spend or cache transcript", async () => {
  const first = await collect(),
    again = await collect();
  expect(first.total).toEqual({ tokens: 30, costUsd: 3 });
  expect(again).toEqual(first);
  expect(first.costBasis).toBe("API price estimate, not a bill");
  const cache = readFileSync(join(f.config.stateDir, "lanes", f.lane.key, "usage-cache.json"), "utf8");
  expect(cache).not.toContain("PRIVATE_TRANSCRIPT_CONTENT");
  expect(cache).not.toContain("PRIVATE_TITLE");
});

test("verified nested children count once, inherited fork entries and task result totals do not", async () => {
  const child = join(f.directory, basename(f.root, ".jsonl"), "helper.jsonl");
  const inherited = usageEntry("new", "2026-01-01T12:20:00Z", 0);
  writeUsageSession(
    child,
    "child-id",
    "2026-01-01T12:20:00Z",
    [inherited, usageEntry("child-call", "2026-01-01T12:25:00Z", 4)],
    { parentSession: f.root },
  );
  const nested = join(f.directory, basename(f.root, ".jsonl"), "helper", "nested.jsonl");
  writeUsageSession(
    nested,
    "nested-id",
    "2026-01-01T12:26:00Z",
    [usageEntry("nested-call", "2026-01-01T12:27:00Z", 8)],
    { parentSession: "child-id" },
  );
  appendFileSync(
    f.root,
    `${JSON.stringify({
      type: "message",
      id: "task",
      timestamp: "2026-01-01T12:30:00Z",
      message: {
        role: "toolResult",
        toolName: "task",
        details: { results: [{ id: "helper" }], usage: { input: 999, output: 999, cost: { total: 999 } } },
      },
    })}\n`,
  );
  const result = await collect();
  expect(result.issues).toEqual([]);
  expect(result.main).toEqual({ tokens: 30, costUsd: 3 });
  expect(result.subagents).toEqual({ tokens: 30, costUsd: 12 });
  expect(result.total).toEqual({ tokens: 60, costUsd: 15 });
  expect(result.childSessions).toBe(2);
});

test("continuation rotation includes previous calls but copied child journals cannot charge twice", async () => {
  const child = join(f.directory, basename(f.root, ".jsonl"), "helper.jsonl");
  writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child-call", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  const id = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae0";
  const next = join(f.directory, `2026-01-01T12-40-00-000Z_${id}.jsonl`);
  writeUsageSession(next, id, "2026-01-01T12:40:00Z", [usageEntry("rotation-call", "2026-01-01T12:41:00Z", 8)], {
    parentSession: USAGE_ID,
    continuationOf: USAGE_ID,
  });
  const copied = join(f.directory, basename(next, ".jsonl"), "helper.jsonl");
  writeUsageSession(copied, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child-call", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  const result = await collectOmpUsage(f.config, { ...f.lane, session: id }, USAGE_NOW);
  expect(result.issues).toEqual([]);
  expect(result.total).toEqual({ tokens: 60, costUsd: 15 });
  expect(result.childSessions).toBe(1);
  const resumed = await collectOmpUsage(f.config, f.lane, USAGE_NOW);
  expect(resumed.total).toEqual(result.total);
  expect(resumed.observedSession).toBe(id);
  const registry = new Registry(f.config.stateDir);
  await registry.write(f.lane);
  const overlap = { ...f.lane, key: "rotated-overlap", session: id };
  await registry.write(overlap);
  for (const lane of [f.lane, overlap]) {
    const reading = await collectOmpUsage(f.config, lane, USAGE_NOW);
    expect(reading.total.costUsd).toBeNull();
    expect(reading.issues).toContain("session is shared by overlapping lane intervals");
  }
});

test("discarded-turn rewrite and truncation replace cached entries instead of retaining old spend", async () => {
  await collect();
  writeUsageSession(f.root, USAGE_ID, "2026-01-01T12:00:00Z", [
    usageEntry("journaled", "2026-01-01T12:20:00Z", 1, "model_usage"),
  ]);
  expect((await collect()).total).toEqual({ tokens: 15, costUsd: 1 });
  writeFileSync(join(f.config.stateDir, "lanes", f.lane.key, "usage-cache.json"), "{truncated");
  expect((await collect()).total).toEqual({ tokens: 15, costUsd: 1 });
});

test("unbound, partial, missing or conflicting records are unknown, never free", async () => {
  const { session, ...unbound } = f.lane;
  expect(session).toBe(USAGE_ID);
  expect((await collectOmpUsage(f.config, unbound, USAGE_NOW)).total.costUsd).toBeNull();
  appendFileSync(f.root, "{truncated");
  const partial = await collect();
  expect(partial.total).toEqual({ tokens: null, costUsd: null });
  expect(partial.issues).toContain("unreadable session record");
  writeUsageSession(f.root, USAGE_ID, "2026-01-01T12:00:00Z", [
    usageEntry("same", "2026-01-01T12:20:00Z", 1),
    usageEntry("same", "2026-01-01T12:20:00Z", 2),
  ]);
  expect((await collect()).issues).toContain("conflicting usage record identity");
});

test("closed interval excludes subsequent work and missing child provenance is not a zero", async () => {
  const closed = await collectOmpUsage(
    f.config,
    { ...f.lane, closedAt: "2026-01-01T12:20:30Z", status: "closed" },
    USAGE_NOW,
  );
  expect(closed.total).toEqual({ tokens: 15, costUsd: 1 });
  appendFileSync(
    f.root,
    `${JSON.stringify({
      type: "message",
      id: "task",
      timestamp: "2026-01-01T12:30:00Z",
      message: { role: "toolResult", toolName: "task" },
    })}\n`,
  );
  const missing = await collect();
  expect(missing.total.costUsd).toBeNull();
  expect(missing.issues).toContain("task result exists without inspectable child sessions");
});
