import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { Registry } from "../src/registry.ts";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_ID, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());
const collect = () => collectOmpUsage(f.config, f.lane, USAGE_NOW);
const artifacts = (file: string) => file.slice(0, -".jsonl".length);
const nextId = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2";
const task = (file: string, ids: readonly string[], at = "2026-01-01T12:30:00Z") =>
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "message",
      id: "task",
      timestamp: at,
      message: { role: "toolResult", toolName: "task", details: { results: ids.map((id) => ({ id })) } },
    })}\n`,
  );

test("native shared artifact directory attributes dotted grandchildren to their recorded parent", async () => {
  const child = join(artifacts(f.root), "helper.jsonl");
  writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  const grandchild = join(artifacts(f.root), "helper.nested.jsonl");
  writeUsageSession(
    grandchild,
    "nested-id",
    "2026-01-01T12:26:00Z",
    [usageEntry("nested", "2026-01-01T12:27:00Z", 8)],
    { parentSession: child },
  );
  task(child, ["helper.nested"]);
  task(f.root, ["helper"]);
  const result = await collect();
  expect(result.issues).toEqual([]);
  expect(result.main).toEqual({ tokens: 30, costUsd: 3 });
  expect(result.subagents).toEqual({ tokens: 30, costUsd: 12 });
  expect(result.total).toEqual({ tokens: 60, costUsd: 15 });
  expect(result.childSessions).toBe(2);
});

test("a new billed entry can precede its continuation header without being inherited", async () => {
  writeUsageSession(f.root, USAGE_ID, "2026-01-01T12:00:00Z", [usageEntry("prior", "2026-01-01T12:20:00Z", 2)]);
  const next = join(f.directory, `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
  writeUsageSession(
    next,
    nextId,
    "2026-01-01T12:40:00Z",
    [usageEntry("prior", "2026-01-01T12:20:00Z", 2), usageEntry("queued", "2026-01-01T12:39:59.999Z", 7)],
    { parentSession: USAGE_ID, continuationOf: USAGE_ID },
  );
  const result = await collect();
  expect(result.issues).toEqual([]);
  expect(result.total).toEqual({ tokens: 30, costUsd: 9 });
});

test("a task receipt preceding the continuation header still requires its child journal", async () => {
  const next = join(f.directory, `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
  writeUsageSession(next, nextId, "2026-01-01T12:40:00Z", [], { parentSession: USAGE_ID, continuationOf: USAGE_ID });
  task(next, ["missing"], "2026-01-01T12:39:59.999Z");
  const result = await collect();
  expect(result.total.costUsd).toBeNull();
  expect(result.issues).toContain("expected child session unavailable");
});

test("a child continuation follows its verified ancestry in the shared directory", async () => {
  const child = join(artifacts(f.root), "helper.jsonl");
  writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  const next = join(artifacts(f.root), `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
  writeUsageSession(
    next,
    nextId,
    "2026-01-01T12:40:00Z",
    [usageEntry("child", "2026-01-01T12:25:00Z", 4), usageEntry("child-queued", "2026-01-01T12:39:59.999Z", 8)],
    { parentSession: "child-id", continuationOf: "child-id" },
  );
  task(f.root, ["helper"]);
  const result = await collect();
  expect(result.issues).toEqual([]);
  expect(result.total).toEqual({ tokens: 60, costUsd: 15 });
  expect(result.childSessions).toBe(1);
});

test("native default and named advisors belong to their own main or child session", async () => {
  const child = join(artifacts(f.root), "helper.jsonl");
  writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  for (const [path, id, cost] of [
    [join(artifacts(f.root), "__advisor.jsonl"), "advisor-main", 2],
    [join(artifacts(f.root), "__advisor.named.jsonl"), "advisor-named", 7],
    [join(artifacts(child), "__advisor.jsonl"), "advisor-child", 8],
  ] as const)
    writeUsageSession(path, id, "2026-01-01T12:22:00Z", [usageEntry(id, "2026-01-01T12:25:00Z", cost)]);
  task(f.root, ["helper"]);
  const result = await collect();
  expect(result.issues).toEqual([]);
  expect(result.main).toEqual({ tokens: 60, costUsd: 12 });
  expect(result.subagents).toEqual({ tokens: 30, costUsd: 12 });
  expect(result.total).toEqual({ tokens: 90, costUsd: 24 });
  expect(result.childSessions).toBe(1);
  expect((await collect()).total).toEqual(result.total);
});

test("live collector contention is an unknown lane observation rather than a failed aggregate", async () => {
  await collect();
  const lock = takeLock(
    join(f.config.stateDir, "lanes", f.lane.key, "usage-cache.json.lock"),
    USAGE_NOW,
    (message) => new Error(message),
    { keepLiveOwner: true },
  );
  if (typeof lock === "string") throw new Error(lock);
  try {
    const result = await collect();
    expect(result.total).toEqual({ tokens: null, costUsd: null });
    expect(result.issues).toContain("usage collection in progress");
  } finally {
    lock();
  }
});

for (const fork of [false, true])
  test(`recorded prior lane binding survives a ${fork ? "fork" : "new"} session`, async () => {
    const next = join(f.directory, `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
    writeUsageSession(
      next,
      nextId,
      "2026-01-01T12:40:00Z",
      [...(fork ? [usageEntry("new", "2026-01-01T12:20:00Z", 0)] : []), usageEntry("next", "2026-01-01T12:41:00Z", 4)],
      { parentSession: USAGE_ID },
    );
    const rebound = { ...f.lane, session: nextId, priorSessions: [USAGE_ID] };
    const result = await collectOmpUsage(f.config, rebound, USAGE_NOW);
    expect(result.issues).toEqual([]);
    expect(result.total).toEqual({ tokens: 45, costUsd: 7 });
  });

for (const linked of [false, true])
  test(`a mismatched header is ${linked ? "incomplete when linked" : "irrelevant when unrelated"}`, async () => {
    const file = join(f.directory, `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
    writeUsageSession(
      file,
      "wrong-id",
      "2026-01-01T12:40:00Z",
      [],
      linked ? { parentSession: USAGE_ID, continuationOf: USAGE_ID } : {},
    );
    const result = await collect();
    if (linked) {
      expect(result.total.costUsd).toBeNull();
      expect(result.issues).toContain("session header identity mismatch");
    } else {
      expect(result.issues).toEqual([]);
      expect(result.total.costUsd).toBe(3);
    }
  });

for (const bad of [null, "not-an-array", [42]])
  test(`malformed prior binding history ${JSON.stringify(bad)} cannot make ownership look complete`, async () => {
    const damaged = JSON.parse(JSON.stringify({ ...f.lane, priorSessions: bad }));
    expect((await collectOmpUsage(f.config, damaged, USAGE_NOW)).issues).toContain("lane session history unavailable");
    await new Registry(f.config.stateDir).write({ ...damaged, key: "damaged-history", session: nextId });
    const result = await collect();
    expect(result.total.costUsd).toBeNull();
    expect(result.issues).toContain("lane ownership history unavailable");
  });
