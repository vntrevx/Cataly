import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceError, isEvidenceSequence } from "./evidence.ts";

/** Called only under Registry.locked, immediately before the synchronous journal append. */
export const nextEvidenceSequence = (stateDir: string, key: string): number => {
  let last = 0;
  // Read accepted ordinals, not progress: neither writer may import the other through its sequence allocator.
  for (const name of ["reports.jsonl", "checkpoints.jsonl"]) {
    const path = join(stateDir, "lanes", key, name);
    if (!existsSync(path)) continue;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (
          typeof record !== "object" ||
          record === null ||
          !("key" in record) ||
          record.key !== key ||
          !("at" in record) ||
          typeof record.at !== "string" ||
          !Number.isFinite(Date.parse(record.at))
        )
          throw new EvidenceError("invalid evidence journal record");
        const sequence = "evidenceSequence" in record ? record.evidenceSequence : undefined;
        if (sequence !== undefined && !isEvidenceSequence(sequence))
          throw new EvidenceError("invalid evidenceSequence");
        last = Math.max(last, sequence ?? 0);
      } catch (error) {
        throw new EvidenceError(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const next = last + 1;
  if (!isEvidenceSequence(next)) throw new EvidenceError("evidence sequence exhausted");
  return next;
};
