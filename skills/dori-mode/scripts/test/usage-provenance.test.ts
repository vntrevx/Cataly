import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_ID, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());

test("a partially missing task batch is unknown even when one child file is present", async () => {
  const child = join(f.directory, basename(f.root, ".jsonl"), "present.jsonl");
  writeUsageSession(child, "child-id", "2026-01-01T12:22:00Z", [usageEntry("child-call", "2026-01-01T12:25:00Z", 4)], {
    parentSession: f.root,
  });
  appendFileSync(
    f.root,
    `${JSON.stringify({
      type: "message",
      id: "task",
      timestamp: "2026-01-01T12:30:00Z",
      message: {
        role: "toolResult",
        toolName: "task",
        details: { results: [], progress: [{ id: "present" }, { id: "missing" }] },
      },
    })}\n`,
  );
  const result = await collectOmpUsage(f.config, f.lane, USAGE_NOW);
  expect(result.total.costUsd).toBeNull();
  expect(result.issues).toContain("expected child session unavailable");
});

test("an unrelated child cannot become lane spend merely by being in its artifact directory", async () => {
  const child = join(f.directory, basename(f.root, ".jsonl"), "foreign.jsonl");
  writeUsageSession(
    child,
    "foreign-id",
    "2026-01-01T12:22:00Z",
    [usageEntry("foreign-call", "2026-01-01T12:25:00Z", 100)],
    { parentSession: "another-session" },
  );
  const result = await collectOmpUsage(f.config, f.lane, USAGE_NOW);
  expect(result.total.costUsd).toBeNull();
  expect(result.issues).toContain("child session relationship unverified");
});

for (const zero of [false, true])
  test(`old task receipts need evidence rather than age alone to exclude child spend: zero=${zero}`, async () => {
    appendFileSync(
      f.root,
      `${JSON.stringify({
        type: "message",
        id: "old-task",
        timestamp: "2026-01-01T12:05:00Z",
        message: {
          role: "toolResult",
          toolName: "task",
          ...(zero ? { details: { results: [{ id: "NeverStarted", exitCode: 1, tokens: 0, requests: 0 }] } } : {}),
        },
      })}\n`,
    );
    const result = await collectOmpUsage(f.config, f.lane, USAGE_NOW);
    expect(result.issues).toEqual(zero ? [] : ["task result exists without inspectable child sessions"]);
    expect(result.total).toEqual(zero ? { tokens: 30, costUsd: 3 } : { tokens: null, costUsd: null });
  });

test("later incomplete evidence makes a closed interval snapshot unknown rather than proving no earlier child spend", async () => {
  const lane = { ...f.lane, closedAt: "2026-01-01T12:30:00Z" };
  expect((await collectOmpUsage(f.config, lane, USAGE_NOW)).total.costUsd).toBe(3);
  appendFileSync(
    f.root,
    `${JSON.stringify({
      type: "message",
      id: "later-task",
      timestamp: "2026-01-01T12:40:00Z",
      message: {
        role: "toolResult",
        toolName: "task",
        details: { progress: [{ id: "Unverified", status: "pending", tokens: 0, requests: 0 }] },
      },
    })}\n`,
  );
  const result = await collectOmpUsage(f.config, lane, USAGE_NOW);
  expect(result.total).toEqual({ tokens: null, costUsd: null });
  expect(result.issues).toContain("expected child session unavailable");
});

test("adjacent lane intervals charge a boundary call only to the later lane", async () => {
  const earlier = await collectOmpUsage(f.config, { ...f.lane, closedAt: "2026-01-01T12:20:00Z" }, USAGE_NOW);
  const later = await collectOmpUsage(
    f.config,
    { ...f.lane, key: "later-lane", openedAt: "2026-01-01T12:20:00Z" },
    USAGE_NOW,
  );
  expect(earlier.total).toEqual({ tokens: 0, costUsd: 0 });
  expect(later.total).toEqual({ tokens: 30, costUsd: 3 });
});

test("root forks exclude inherited IDs even when a copied call has the same timestamp as the new header", async () => {
  const id = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae1";
  const file = join(f.directory, `2026-01-01T12-20-00-000Z_${id}.jsonl`);
  writeUsageSession(
    file,
    id,
    "2026-01-01T12:20:00Z",
    [usageEntry("new", "2026-01-01T12:20:00Z", 0), usageEntry("fork-call", "2026-01-01T12:25:00Z", 4)],
    { parentSession: USAGE_ID },
  );
  const result = await collectOmpUsage(f.config, { ...f.lane, session: id }, USAGE_NOW);
  expect(result.issues).toEqual([]);
  expect(result.total).toEqual({ tokens: 15, costUsd: 4 });
});
