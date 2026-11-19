import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { takeLock } from "../src/checkpoint-lock.ts";
import { type CheckpointInput, Checkpoints } from "../src/checkpoints.ts";
import { type EvidenceRef, type Evidenced, fileEvidence } from "../src/evidence.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Clock } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { withState } from "./fakes.ts";

export const KEY = "sequence-lane";
export const T0 = Date.parse("2026-01-01T00:00:00Z");
export const iso = (ms: number): string => new Date(ms).toISOString();
export type Role = "report" | "checkpoint";

/** A fresh state dir with one watched file; `ref` writes the file and returns the evidence of those bytes. */
export const sequenceState = () => {
  const state = withState();
  const source = join(state.dir, "result.txt");
  const ref = (content: string): EvidenceRef => {
    writeFileSync(source, content);
    return fileEvidence(source, state.dir);
  };
  return { ...state, source, ref, reports: new Reports(state.dir), checkpoints: new Checkpoints(state.dir) };
};

/** One checkpoint step; its payload follows from its name, so the same name again is a retry of the same step. */
export const step = (name: string, source: string, evidenceRefs?: readonly EvidenceRef[]): CheckpointInput => ({
  step: name,
  result: name,
  evidence: [source],
  remoteEffects: [`receipt:${name}`],
  ...(evidenceRefs ? { evidenceRefs } : {}),
});

/** Holds the lane's registry lock with the lock code Registry.locked takes it with; this live process owns it. */
export const holdRegistry = (stateDir: string): (() => void) => {
  const registry = new Registry(stateDir);
  mkdirSync(registry.dir, { recursive: true });
  const held = takeLock(`${registry.path(KEY)}.lock`, Date.now(), (message) => new Error(message));
  if (typeof held === "string") throw new Error(`registry lock is already held: ${held}`);
  return held;
};

/** A journal's lines exactly as stored, parsed without the readers under test. */
export const journal = (path: string): Evidenced[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Evidenced);

/** The source-grouped merge the production verdict folds: every report-journal record, then every checkpoint. */
export const grouped = (stateDir: string): Evidenced[] => [
  ...(new Reports(stateDir).read(KEY)?.evidenced ?? []),
  ...new Checkpoints(stateDir).read(KEY),
];

export const lane = (cwd: string): Lane => ({
  key: KEY,
  title: "evidence sequence",
  thread: "none",
  brief: "brief.md",
  done: "file result.txt",
  cwd,
  openedAt: iso(T0),
  reportProtocol: "jsonl-v1",
});

/** The production observer over one watched file; Git is not consulted, so no command is expected to run. */
export const supervisor = (stateDir: string, clock: Pick<Clock, "now">, source: string, reports?: Reports) =>
  new Supervision(
    {
      stateDir,
      clock,
      run: async (argv) => {
        throw new Error(`unexpected ${argv.join(" ")}`);
      },
      ...(reports ? { reports } : {}),
    },
    { activityPaths: [source], gitActivity: false },
  );

const src = (name: string): string => new URL(`../src/${name}`, import.meta.url).pathname;

/**
 * Starts one real evidence writer at `now` in its own `bun test` process. The child only observes its own attempts
 * on the registry lock: at the first one a live holder refuses, it prints WAITING and, given a gate, keeps that
 * refused attempt until the gate file exists, so the test decides which of two waiters is accepted first. It prints
 * what the real call returned and exits 0 only if that call succeeded.
 */
export const spawnWriter = (
  stateDir: string,
  role: Role,
  now: number,
  source: string,
  ref: EvidenceRef,
  gate?: string,
) => {
  const script = join(stateDir, `${role}-writer.test.ts`);
  const call =
    role === "report"
      ? `new Reports(dir).report(key, "milestone", "accepted", ${now}, undefined, ${JSON.stringify([ref])})`
      : `new Checkpoints(dir).write(key, ${JSON.stringify(step("accepted", source, [ref]))}, ${now})`;
  writeFileSync(
    script,
    `import { spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Checkpoints } from ${JSON.stringify(src("checkpoints.ts"))};
import { Registry } from ${JSON.stringify(src("registry.ts"))};
import { Reports } from ${JSON.stringify(src("reports.ts"))};
const dir = ${JSON.stringify(stateDir)};
const key = ${JSON.stringify(KEY)};
const gate = ${JSON.stringify(gate ?? null)};
test(${JSON.stringify(`${role} writer`)}, async () => {
  const lock = new Registry(dir).path(key) + ".lock";
  const openSync = fs.openSync;
  let waiting = false;
  spyOn(fs, "openSync").mockImplementation(new Proxy(openSync, {
    apply(target, receiver, args) {
      try {
        return Reflect.apply(target, receiver, args);
      } catch (error) {
        if (args[0] === lock && error?.code === "EEXIST" && !waiting) {
          waiting = true;
          process.stdout.write("WAITING\\n");
          const deadline = Date.now() + 10_000;
          while (gate && !fs.existsSync(gate)) {
            if (Date.now() >= deadline) throw new Error("writer gate timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        throw error;
      }
    },
  }));
  process.stdout.write("RESULT " + JSON.stringify(await ${call}) + "\\n");
}, 20_000);
`,
  );
  const child = Bun.spawn([process.execPath, "test", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  // Reads until `marker` is printed, or with null until the child closes its stdout.
  const read = async (marker: string | null): Promise<string> => {
    while (marker === null || !output.includes(marker)) {
      const next = await reader.read();
      if (next.done) {
        if (marker === null) return output;
        throw new Error(`${role} writer ended before ${marker.trim()}: ${output}${await stderr}`);
      }
      output += decoder.decode(next.value, { stream: true });
    }
    return output;
  };
  return {
    child,
    waiting: (): Promise<string> => read("WAITING\n"),
    /** What the writer's real call returned, once its process exited 0. */
    finished: async (): Promise<unknown> => {
      const out = await read(null);
      const code = await child.exited;
      if (code !== 0) throw new Error(`${role} writer exited ${code}: ${out}${await stderr}`);
      const line = out.split("\n").find((printed) => printed.startsWith("RESULT "));
      if (!line) throw new Error(`${role} writer printed no result: ${out}`);
      return JSON.parse(line.slice("RESULT ".length));
    },
  };
};
