import { Checkpoints } from "./checkpoints.ts";
import { EvidenceError, isEvidenceSequence } from "./evidence.ts";
import { Reports } from "./reports.ts";

/** Called only under Registry.locked, immediately before the synchronous journal append. */
export const nextEvidenceSequence = (stateDir: string, key: string): number => {
  const records = [...(new Reports(stateDir).read(key)?.evidenced ?? []), ...new Checkpoints(stateDir).read(key)];
  let last = 0;
  for (const record of records) last = Math.max(last, record.evidenceSequence ?? 0);
  const next = last + 1;
  if (!isEvidenceSequence(next)) throw new EvidenceError("evidence sequence exhausted");
  return next;
};
