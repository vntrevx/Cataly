import { expect, test } from "bun:test";
import { appendFileSync, cpSync } from "node:fs";
import { basename, join } from "node:path";
import { collectOmpUsage } from "../src/usage-omp.ts";
import { usageEntry, usageFixture, USAGE_NOW, writeUsageSession } from "./usage-fakes.ts";

for (const rotated of [false, true])
  test(`seance historical task receipts stay context after continuation=${rotated}`, async () => {
    const f = usageFixture();
    try {
      const artifacts = join(f.directory, basename(f.root, ".jsonl"));
      const child = join(artifacts, "Reader.jsonl");
      const entries = [
        {
          type: "message",
          id: "historical-task",
          timestamp: "2026-01-01T12:05:00Z",
          message: { role: "toolResult", toolName: "task", details: { results: [{ id: "HistoricalWorker" }] } },
        },
        usageEntry("consult", "2026-01-01T12:25:00Z", 8),
        {
          type: "message",
          id: "owned-task",
          timestamp: "2026-01-01T12:26:00Z",
          message: { role: "toolResult", toolName: "task", details: { results: [{ id: "Reader.Helper" }] } },
        },
      ];
      const source = { parentSession: "historical-id", seanceSource: "/archive/source.jsonl" };
      writeUsageSession(child, "reader-id", "2026-01-01T12:15:00Z", entries, source);
      const childArtifacts = join(artifacts, "Reader");
      writeUsageSession(
        join(childArtifacts, "Reader.Helper.jsonl"),
        "helper-id",
        "2026-01-01T12:26:30Z",
        [usageEntry("helper", "2026-01-01T12:27:00Z", 4)],
        { parentSession: child },
      );
      appendFileSync(
        f.root,
        `${JSON.stringify({ type: "message", id: "parent-task", timestamp: "2026-01-01T12:29:00Z", message: { role: "toolResult", toolName: "task", details: { results: [{ id: "Reader" }] } } })}\n`,
      );
      if (rotated) {
        const id = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2";
        const name = `2026-01-01T12-35-00-000Z_${id}`;
        writeUsageSession(
          join(artifacts, `${name}.jsonl`),
          id,
          "2026-01-01T12:35:00Z",
          [...entries, usageEntry("rotation", "2026-01-01T12:40:00Z", 16)],
          { ...source, parentSession: "reader-id", continuationOf: "reader-id" },
        );
        cpSync(childArtifacts, join(artifacts, name), { recursive: true });
      }
      const result = await collectOmpUsage(f.config, f.lane, USAGE_NOW, Date.parse("2026-01-01T12:24:00Z"));
      expect(result.issues).toEqual([]);
      expect(result.total).toEqual({ tokens: rotated ? 45 : 30, costUsd: rotated ? 28 : 12 });
      expect(result.childSessions).toBe(2);
    } finally {
      f.done();
    }
  });
