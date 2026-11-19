import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Registry } from "../src/registry.ts";
import { iso, KEY, sequenceState, step, T0 } from "./evidence-sequence-fixture.ts";

for (const journal of ["reports", "checkpoints"] as const) {
  for (const broken of ["json", "sequence", "key", "at"] as const) {
    test(`a ${broken} error in ${journal} refuses the other evidence writer without changing either journal`, async () => {
      const f = sequenceState();
      try {
        const refs = [f.ref("A")];
        const record =
          journal === "reports"
            ? { type: "report", key: KEY, at: iso(T0), kind: "milestone", text: "accepted", evidenceRefs: refs }
            : { key: KEY, at: iso(T0), ...step("accepted", f.source, refs) };
        const line =
          broken === "json"
            ? "{"
            : JSON.stringify({
                ...record,
                [broken === "sequence" ? "evidenceSequence" : broken]: broken === "sequence" ? 0 : "invalid",
              });
        const corrupt = journal === "reports" ? f.reports.path(KEY) : f.checkpoints.path(KEY);
        const target = journal === "reports" ? f.checkpoints.path(KEY) : f.reports.path(KEY);
        mkdirSync(dirname(corrupt), { recursive: true });
        writeFileSync(corrupt, `${line}\n`);
        const writing =
          journal === "reports"
            ? f.checkpoints.write(KEY, step("new", f.source, refs), T0)
            : f.reports.report(KEY, "milestone", "new", T0, undefined, refs);
        await expect(writing).rejects.toThrow(`${corrupt}:1:`);
        expect(readFileSync(corrupt, "utf8")).toBe(`${line}\n`);
        expect(existsSync(target)).toBe(false);
        expect(existsSync(`${f.checkpoints.path(KEY)}.lock`)).toBe(false);
        expect(existsSync(`${new Registry(f.dir).path(KEY)}.lock`)).toBe(false);
      } finally {
        f.done();
      }
    });
  }
}
