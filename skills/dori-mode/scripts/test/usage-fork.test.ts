import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_ID, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());
const artifacts = (file: string) => file.slice(0, -".jsonl".length);
const nextId = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2";

for (const kind of ["fork", "rebind", "continuation"] as const)
  test(`native ${kind} artifact copies retain parent paths without rebilling inherited child or advisor calls`, async () => {
    writeUsageSession(f.root, USAGE_ID, "2026-01-01T12:00:00Z", [usageEntry("root", "2026-01-01T12:20:00Z", 3)]);
    const child = join(artifacts(f.root), "helper.jsonl");
    writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child", "2026-01-01T12:25:00Z", 4)], {
      parentSession: f.root,
    });
    writeUsageSession(
      join(artifacts(f.root), "helper.nested.jsonl"),
      "nested-id",
      "2026-01-01T12:26:00Z",
      [usageEntry("nested", "2026-01-01T12:27:00Z", 8)],
      { parentSession: child },
    );
    writeUsageSession(join(artifacts(f.root), "__advisor.jsonl"), "advisor-id", "2026-01-01T12:22:00Z", [
      usageEntry("advisor", "2026-01-01T12:25:00Z", 16),
    ]);
    const next = join(f.directory, `2026-01-01T12-40-00-000Z_${nextId}.jsonl`);
    writeUsageSession(
      next,
      nextId,
      "2026-01-01T12:40:00Z",
      [
        usageEntry("root", "2026-01-01T12:20:00Z", kind === "continuation" ? 3 : 0),
        usageEntry("next", "2026-01-01T12:45:00Z", 4),
      ],
      { parentSession: USAGE_ID, ...(kind === "continuation" ? { continuationOf: USAGE_ID } : {}) },
    );
    cpSync(artifacts(f.root), artifacts(next), { recursive: true });
    for (const [file, id, cost] of [
      ["helper.jsonl", "child-new", 32],
      ["helper.nested.jsonl", "nested-new", 64],
      ["__advisor.jsonl", "advisor-new", 128],
    ] as const)
      appendFileSync(join(artifacts(next), file), `${JSON.stringify(usageEntry(id, "2026-01-01T12:46:00Z", cost))}\n`);
    const lane = {
      ...f.lane,
      session: kind === "continuation" ? USAGE_ID : nextId,
      ...(kind === "rebind" ? { priorSessions: [USAGE_ID] } : {}),
    };
    const result = await collectOmpUsage(f.config, lane, USAGE_NOW);
    expect(result.issues).toEqual([]);
    expect(result.main.costUsd).toBe(kind === "fork" ? 132 : 151);
    expect(result.subagents.costUsd).toBe(kind === "fork" ? 96 : 108);
    expect(result.total).toEqual({ tokens: kind === "fork" ? 60 : 120, costUsd: kind === "fork" ? 228 : 259 });
    expect((await collectOmpUsage(f.config, lane, USAGE_NOW)).total).toEqual(result.total);
  });

test("equal entry IDs and timestamps in distinct sibling sessions are independently billed", async () => {
  for (const [name, id, cost] of [
    ["one", "child-one", 4],
    ["two", "child-two", 8],
  ] as const)
    writeUsageSession(
      join(artifacts(f.root), `${name}.jsonl`),
      id,
      "2026-01-01T12:22:00Z",
      [usageEntry("same", "2026-01-01T12:25:00Z", cost)],
      { parentSession: f.root },
    );
  const result = await collectOmpUsage(f.config, f.lane, USAGE_NOW);
  expect(result.issues).toEqual([]);
  expect(result.subagents.costUsd).toBe(12);
});
