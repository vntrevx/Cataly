import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { Checkpoints } from "../src/checkpoints.ts";
import { recordExecution } from "../src/lane-run.ts";
import { Registry } from "../src/registry.ts";
import { reportId } from "../src/reports.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import {
  CURRENT_RUN,
  NEXT_RUN,
  OLD_RUN,
  REQUEST,
  T0,
  provenanceOf,
  seedRequest,
  sourcedLane,
} from "./request-fixtures.ts";

const KEY = sourcedLane.key;
const step = (name: string, effect = "push:abc123") => [
  "checkpoint",
  KEY,
  "--step",
  name,
  "--result",
  "ok",
  "--evidence",
  "log",
  "--remote-effect",
  effect,
];
const reportArgs = ["report", KEY, "--kind", "milestone", "--text", "A result", "--json"];
const run = (runId: string | undefined) => ({ environment: { DORI_LANE_RUN: runId } });
const json = (out: string) => JSON.parse(out.split("\n")[0] ?? "");

test("a replayed checkpoint step returns its original run's receipt and its remote effect cannot move to another step", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await seedRequest(stateDir);
    const first = await f.invoke(step("push"), run(OLD_RUN));
    expect([first.code, first.err]).toEqual([0, ""]);
    const original = json(first.out);
    expect(original.unchanged).toBe(false);
    expect(original.checkpoint.provenance).toEqual(provenanceOf(OLD_RUN));
    const path = new Checkpoints(stateDir).path(KEY);
    const before = readFileSync(path, "utf8");
    for (const runId of [CURRENT_RUN, undefined]) {
      const replay = await f.invoke(step("push"), run(runId));
      expect(replay.code).toBe(0);
      expect(json(replay.out)).toMatchObject({ checkpoint: original.checkpoint, unchanged: true });
      expect(json(replay.out).attribution).toBeUndefined();
      const moved = await f.invoke(step("push-again"), run(runId));
      expect(moved.code).not.toBe(0);
      expect(moved.err).toContain("push:abc123 already recorded by step push");
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["unknown", "00000000-0000-4000-8000-000000000099"],
])("a %s run keeps its remote effect unattributed without becoming the current checkpoint", async (_name, runId) => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const { lane } = await seedRequest(stateDir);
    const current = await f.invoke(step("build", "build:1"), run(CURRENT_RUN));
    expect(current.code).toBe(0);
    const currentCheckpoint = json(current.out).checkpoint;
    const stray = await f.invoke(step("deploy", "deploy:1"), run(runId));
    expect([stray.code, stray.err]).toEqual([0, ""]);
    const receipt = json(stray.out);
    expect(receipt.checkpoint.provenance).toBeUndefined();
    expect(receipt.checkpoint.remoteEffects).toEqual(["deploy:1"]);
    expect(receipt.attribution.state).toBe("unverified");
    const old = await f.invoke(step("late", "late:1"), run(OLD_RUN));
    expect(json(old.out).checkpoint.provenance).toEqual(provenanceOf(OLD_RUN));
    const journal = new Checkpoints(stateDir);
    expect(journal.read(KEY).map((c) => c.remoteEffects)).toEqual([["build:1"], ["deploy:1"], ["late:1"]]);
    expect(journal.latest(lane)).toEqual(currentCheckpoint);
    const status = await f.invoke(["status", KEY, "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).lanes[0].checkpoint).toEqual(currentCheckpoint);
  });
});

test("a legacy checkpoint is never promoted to a sourced record by a later run", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await seedRequest(stateDir);
    const journal = new Checkpoints(stateDir);
    const legacy = journal.write(
      KEY,
      { step: "push", result: "ok", evidence: ["log"], remoteEffects: ["push:abc123"] },
      T0,
    );
    const before = readFileSync(journal.path(KEY), "utf8");
    const replay = await f.invoke(step("push"), run(CURRENT_RUN));
    expect(replay.code).toBe(0);
    const receipt = json(replay.out);
    expect(receipt.checkpoint).toEqual(legacy.checkpoint);
    expect("provenance" in receipt.checkpoint).toBe(false);
    expect(readFileSync(journal.path(KEY), "utf8")).toBe(before);

    const { requestId: _r, runId: _u, ...unsourced } = { ...sourcedLane, key: "legacy-lane" };
    await new Registry(stateDir).write(unsourced);
    const plain = await f.invoke(
      ["checkpoint", "legacy-lane", "--step", "s", "--result", "ok", "--evidence", "e", "--remote-effect", "legacy:1"],
      run(OLD_RUN),
    );
    expect(plain.code).toBe(0);
    const out = json(plain.out);
    expect(["provenance" in out.checkpoint, "attribution" in out]).toEqual([false, false]);
  });
});

test("reportId binds request, run and native reference while a legacy report keeps the six-field hash", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await seedRequest(stateDir);
    const result = await f.invoke(reportArgs, run(CURRENT_RUN));
    expect(result.code).toBe(0);
    const { id, delivery: _d, ...entry } = JSON.parse(result.out);
    const six = [entry.key, entry.at, entry.kind, entry.text, entry.owner ?? null, entry.generation ?? null];
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const native = provenanceOf(CURRENT_RUN).nativeRef;
    expect(id).toBe(sha([...six, [REQUEST, CURRENT_RUN, [native.sessionId, native.ref.runtime, native.ref.id]]]));
    expect(reportId(entry)).toBe(id);
    const { nativeRef: _n, ...unbound } = entry.provenance;
    const variants = [
      { ...entry, provenance: provenanceOf(OLD_RUN) },
      { ...entry, provenance: unbound },
      { ...entry, provenance: { ...entry.provenance, requestId: "discord:111111111111111111:333333333333333333" } },
      { ...entry, provenance: { ...entry.provenance, nativeRef: { ...native, sessionId: "native-other" } } },
      { ...entry, provenance: undefined },
    ];
    expect(new Set(variants.map(reportId)).has(id)).toBe(false);

    const { requestId: _r, runId: _u, ...unsourced } = { ...sourcedLane, key: "legacy-lane" };
    await new Registry(stateDir).write(unsourced);
    const legacy = await f.invoke(
      ["report", "legacy-lane", "--kind", "done", "--text", "Done", "--owner", "Sum", "--json"],
      run(OLD_RUN),
    );
    expect(legacy.code).toBe(0);
    const old = JSON.parse(legacy.out);
    expect(old.provenance).toBeUndefined();
    expect(old.id).toBe(sha([old.key, old.at, old.kind, old.text, old.owner, old.generation]));
  });
});

test("a generation switch while a report waits on the registry lock keeps each run's original attribution", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const { lane } = await seedRequest(stateDir);
    const registry = new Registry(stateDir);
    const release = takeLock(`${registry.path(KEY)}.lock`, Date.now(), (m) => new Error(m));
    if (typeof release === "string") throw new Error(release);
    const waiting = [OLD_RUN, CURRENT_RUN].map((runId) => f.invoke(reportArgs, run(runId)));
    try {
      // The child processes expose no signal while blocked on a cross-process file lock; this real delay lets them reach
      // it. The attribution assertions hold whether or not they did, so a slow start cannot make this pass wrongly.
      await Bun.sleep(500);
      const next = { ...lane, runId: NEXT_RUN, lifecycleEpoch: "next-generation", session: "native-next" };
      const bound = { ...next, sessionRef: { runtime: "herdr", id: "w1:p9" } } as const;
      recordExecution(stateDir, bound, T0);
      recordExecution(stateDir, bound, T0, next.session);
      writeFileSync(registry.path(KEY), JSON.stringify(next));
    } finally {
      release();
    }
    const [old, current] = await Promise.all(waiting);
    expect([old?.code, current?.code]).toEqual([0, 0]);
    expect(JSON.parse(old?.out ?? "")).toMatchObject({
      generation: "original-generation",
      provenance: provenanceOf(OLD_RUN),
    });
    expect(JSON.parse(current?.out ?? "")).toMatchObject({
      generation: "current-generation",
      provenance: provenanceOf(CURRENT_RUN),
    });
  });
});

test("concurrent checkpoint writers from two runs leave one record whose provenance every acknowledgement returns", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await seedRequest(stateDir);
    const results = await Promise.all(
      [OLD_RUN, CURRENT_RUN, OLD_RUN, CURRENT_RUN].map((r) => f.invoke(step("push"), run(r))),
    );
    const recorded = new Checkpoints(stateDir).read(KEY);
    expect(recorded).toHaveLength(1);
    const [only] = recorded;
    if (!only?.provenance) throw new Error("checkpoint has no original run provenance");
    expect([OLD_RUN, CURRENT_RUN]).toContain(only.provenance.runId);
    expect(only.provenance).toEqual(provenanceOf(only.provenance.runId));
    expect(results.some((r) => r.code === 0)).toBe(true);
    for (const result of results) {
      if (result.code === 0) expect(json(result.out).checkpoint).toEqual(only);
      else expect(result.err).toContain("locked");
    }
  });
});
