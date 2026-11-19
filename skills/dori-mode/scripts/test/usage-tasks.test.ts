import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());
const collect = () => collectOmpUsage(f.config, f.lane, USAGE_NOW);
const artifacts = (file: string) => file.slice(0, -".jsonl".length);
const receipt = (details: Record<string, unknown>, file = f.root, at = "2026-01-01T12:30:00Z") =>
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "message",
      id: "task",
      timestamp: at,
      message: { role: "toolResult", toolName: "task", details },
    })}\n`,
  );

for (const [label, details] of [
  ["failed result", { results: [{ id: "Empty", exitCode: 1, tokens: 0, requests: 0 }] }],
  ["completed result", { results: [{ id: "Empty", exitCode: 0, tokens: 0, requests: 0 }] }],
  ...["completed", "failed", "aborted"].map((status): [string, Record<string, unknown>] => [
    `${status} progress`,
    {
      results: [],
      progress: [{ id: "Empty", status, tokens: 0, requests: 0, cost: 0 }],
    },
  ]),
] as const)
  test(`${label} with explicit zero usage needs no lazily-created journal`, async () => {
    receipt(details);
    const result = await collect();
    expect(result.issues).toEqual([]);
    expect(result.total).toEqual({ tokens: 30, costUsd: 3 });
    expect((await collect()).total).toEqual(result.total);
  });

for (const details of [
  ...["pending", "running"].map((status) => ({ progress: [{ id: "Empty", status, tokens: 0, requests: 0, cost: 0 }] })),
  ...[
    { requests: 1 },
    { tokens: 1 },
    { tokens: "0" },
    { tokens: -1 },
    { usage: { cost: { total: 2 } } },
    { advisor: { cost: 2 } },
  ].map((extra) => ({
    results: [{ id: "Empty", exitCode: 1, tokens: 0, requests: 0, ...extra }],
  })),
  { progress: [{ id: "Empty", status: "failed", tokens: 0, requests: 0, cost: 2 }] },
])
  test(`missing child remains unknown without consistent terminal zero counters ${JSON.stringify(details)}`, async () => {
    receipt(details);
    expect((await collect()).total.costUsd).toBeNull();
  });

for (const nested of [false, true])
  test(`receipt-owned seance counts only its fresh calls, nested=${nested}`, async () => {
    const parent = nested ? join(artifacts(f.root), "Helper.jsonl") : f.root;
    if (nested) {
      writeUsageSession(
        parent,
        "helper-id",
        "2026-01-01T12:22:00Z",
        [usageEntry("helper", "2026-01-01T12:23:00Z", 4)],
        { parentSession: f.root },
      );
      receipt({ results: [{ id: "Helper" }] });
    }
    const id = nested ? "Helper.Reader" : "Reader";
    receipt({ results: [{ id }] }, parent);
    writeUsageSession(
      join(artifacts(parent), `${id}.jsonl`),
      "reader-id",
      "2026-01-01T12:24:00Z",
      [usageEntry("historical", "2026-01-01T12:20:00Z", 0), usageEntry("fresh", "2026-01-01T12:25:00Z", 8)],
      { parentSession: "historical-id", seanceSource: "/archive/source.jsonl" },
    );
    const result = await collect();
    expect(result.issues).toEqual([]);
    expect(result.total).toEqual({ tokens: nested ? 60 : 45, costUsd: nested ? 15 : 11 });
    expect(result.childSessions).toBe(nested ? 2 : 1);
    expect((await collect()).total).toEqual(result.total);
  });

for (const mode of ["since", "adopt", "later receipt"])
  test(`seance ownership evidence is independent of the billed interval: ${mode}`, async () => {
    const future = mode === "later receipt";
    receipt({ results: [{ id: "Reader" }] }, f.root, future ? "2026-01-01T12:50:00Z" : "2026-01-01T12:20:00Z");
    writeUsageSession(
      join(artifacts(f.root), "Reader.jsonl"),
      "reader-id",
      "2026-01-01T12:15:00Z",
      [usageEntry("fresh", "2026-01-01T12:40:00Z", 8)],
      { parentSession: "historical-id", seanceSource: "/archive/source.jsonl" },
    );
    const lane = {
      ...f.lane,
      ...(mode === "adopt" ? { openedAt: "2026-01-01T12:30:00Z" } : {}),
      ...(future ? { closedAt: "2026-01-01T12:45:00Z" } : {}),
    };
    const since = mode === "since" ? Date.parse("2026-01-01T12:30:00Z") : 0;
    const result = await collectOmpUsage(f.config, lane, USAGE_NOW, since);
    expect(result.issues).toEqual([]);
    expect(result.total).toEqual({ tokens: future ? 45 : 15, costUsd: future ? 11 : 8 });
  });

for (const seance of [false, true])
  test(`missing historical task journal cannot turn observed spend into zero, seance=${seance}`, async () => {
    const child = join(artifacts(f.root), "Reader.jsonl");
    receipt({ results: [{ id: "Reader" }] }, f.root, "2026-01-01T12:20:00Z");
    writeUsageSession(
      child,
      "reader-id",
      "2026-01-01T12:15:00Z",
      [usageEntry("fresh", "2026-01-01T12:40:00Z", 8)],
      seance ? { parentSession: "historical-id", seanceSource: "/archive/source.jsonl" } : { parentSession: f.root },
    );
    const since = Date.parse("2026-01-01T12:30:00Z");
    const first = await collectOmpUsage(f.config, f.lane, USAGE_NOW, since);
    unlinkSync(child);
    const missing = await collectOmpUsage(f.config, f.lane, USAGE_NOW, since);
    expect(missing.total.costUsd).toBeNull();
    expect(missing.issues).toContain("expected child session unavailable");
    expect(first.total.costUsd).toBe(8);
  });

for (const proof of ["no receipt", "wrong name", "no seance marker"])
  test(`historical parent is not owned with ${proof}`, async () => {
    if (proof !== "no receipt") receipt({ results: [{ id: proof === "wrong name" ? "Other" : "Reader" }] });
    writeUsageSession(
      join(artifacts(f.root), "Reader.jsonl"),
      "reader-id",
      "2026-01-01T12:24:00Z",
      [usageEntry("fresh", "2026-01-01T12:25:00Z", 8)],
      {
        parentSession: "historical-id",
        ...(proof === "no seance marker" ? {} : { seanceSource: "/archive/source.jsonl" }),
      },
    );
    expect((await collect()).total.costUsd).toBeNull();
  });
