import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonlLine, withFileLock } from "./fs-utils.js";
import { LANE_KEY_PATTERN } from "./lessons.js";

export type CheckpointInput = {
  readonly step: string;
  readonly result: string;
  readonly evidence: readonly string[];
  readonly remoteEffects: readonly string[];
};

export type Checkpoint = CheckpointInput & {
  readonly key: string;
  readonly at: string;
};

export class CheckpointError extends Error {}

function validate(input: CheckpointInput): void {
  if (
    typeof input.step !== "string" ||
    !input.step.trim() ||
    typeof input.result !== "string" ||
    !input.result.trim() ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every((v) => typeof v === "string") ||
    !Array.isArray(input.remoteEffects) ||
    !input.remoteEffects.every((v) => typeof v === "string")
  ) {
    throw new CheckpointError("checkpoint requires step, result, evidence[], and remoteEffects[]");
  }
}

const canonicalPayload = (value: CheckpointInput): string =>
  JSON.stringify({
    step: value.step.trim(),
    result: value.result.trim(),
    evidence: value.evidence,
    remoteEffects: value.remoteEffects,
  });

export class Checkpoints {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY_PATTERN.test(key)) throw new CheckpointError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "checkpoints.jsonl");
  }

  read(key: string): Checkpoint[] {
    const filePath = this.path(key);
    if (!existsSync(filePath)) return [];
    const steps = new Set<string>();
    const out: Checkpoint[] = [];
    for (const [index, line] of readFileSync(filePath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Checkpoint;
        validate(value);
        if (value.key !== key || !Number.isFinite(Date.parse(value.at)) || steps.has(value.step)) {
          throw new CheckpointError("invalid key, timestamp, or duplicate step");
        }
        steps.add(value.step);
        out.push(value);
      } catch (error) {
        throw new CheckpointError(
          `${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return out;
  }

  write(key: string, input: CheckpointInput, now = Date.now()): { checkpoint: Checkpoint; unchanged: boolean } {
    validate(input);
    const filePath = this.path(key);
    const normalized: CheckpointInput = {
      step: input.step.trim(),
      result: input.result.trim(),
      evidence: [...input.evidence],
      remoteEffects: [...input.remoteEffects],
    };

    return withFileLock(`${filePath}.lock`, () => {
      const recorded = this.read(key);
      const previous = recorded.find((entry) => entry.step === normalized.step);
      if (previous) {
        if (canonicalPayload(previous) !== canonicalPayload(normalized)) {
          throw new CheckpointError(`conflicting checkpoint step: ${normalized.step}`);
        }
        return { checkpoint: previous, unchanged: true };
      }
      for (const entry of recorded) {
        const repeated = normalized.remoteEffects.find((receipt) => entry.remoteEffects.includes(receipt));
        if (repeated !== undefined) {
          throw new CheckpointError(`remote effect "${repeated}" already recorded by step "${entry.step}"`);
        }
      }
      const checkpoint: Checkpoint = {
        key,
        at: new Date(now).toISOString(),
        ...normalized,
      };
      appendJsonlLine(filePath, checkpoint);
      return { checkpoint, unchanged: false };
    });
  }
}
