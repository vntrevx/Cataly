import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

for (const failedDelivery of [false, true]) {
  test(`Git failure after a complete cycle preserves the confirmed stall and ${failedDelivery ? "retries" : "deduplicates"} its alert`, async () => {
    let attempts = 0;
    const f = coverageFixture(state, () => {
      if (++attempts === 1 && failedDelivery) throw new Error("delivery unavailable");
    });
    for (let window = 0; window < 7; window++) await f.sweep();
    if (failedDelivery) await expect(f.sweep()).rejects.toThrow("alert delivery failed");
    else await f.sweep();
    expect(f.observation().hung).toBe(true);
    const index = join(f.repo, ".git", "index");
    fs.writeFileSync(index, "corrupt index fixture");
    const failed = (await f.sweep()).result;
    expect(failed.evidenceError).toContain("Git evidence observation failed");
    expect(failed.hung).toBe(false);
    expect(f.observation().hung).toBe(true);
    expect(attempts).toBe(failedDelivery ? 2 : 1);
    fs.unlinkSync(index);
    for (let window = 0; window < 8; window++) expect((await f.sweep()).result.alerts).toEqual([]);
    expect(attempts).toBe(failedDelivery ? 2 : 1);
  });

  test(`a report without new evidence preserves confirmed hung and ${failedDelivery ? "retries" : "deduplicates"} its alert`, async () => {
    let attempts = 0;
    const f = coverageFixture(state, () => {
      if (++attempts === 1 && failedDelivery) throw new Error("delivery unavailable");
    });
    for (let window = 0; window < 7; window++) await f.sweep();
    if (failedDelivery) await expect(f.sweep()).rejects.toThrow("alert delivery failed");
    else await f.sweep();
    const before = f.observation().lastEvidenceAt;
    const source = f.paths[0];
    if (!source) throw new Error("fixture needs its first candidate");
    for (const refs of [[], [fileEvidence(source, f.repo)]]) {
      const reportedAt = f.clock.at + 1;
      f.reports.report(f.lane.key, "milestone", "still working", reportedAt, refs);
      const result = (await f.sweep()).result;
      expect(result.state).toBe("stalled");
      expect(result.heldHung).toBe(true);
      expect(result.lastEvidenceAt).toBe(before);
      expect(result.lastReportAt).toBe(new Date(reportedAt).toISOString());
      expect(attempts).toBe(failedDelivery ? 2 : 1);
    }
    for (let window = 0; window < 8; window++) expect((await f.sweep()).result.alerts).toEqual([]);
    expect(attempts).toBe(failedDelivery ? 2 : 1);
  });
}

test("one unreadable file cannot starve the rest of its window or the final window", async () => {
  const f = coverageFixture(state);
  const first = f.paths[0];
  const last = f.paths[999];
  if (!first || !last) throw new Error("fixture needs its edge candidates");
  fs.chmodSync(first, 0);
  try {
    const initial = (await f.sweep()).result;
    expect(initial.evidenceError).toContain("EACCES");
    expect(initial.hung).toBe(false);
    expect(f.refs()).toHaveLength(255);
    fs.writeFileSync(last, "late window work");
    for (let window = 0; window < 3; window++) expect((await f.sweep()).result.hung).toBe(false);
    expect(new Set(f.refs().map((ref) => ref.ref)).size).toBe(999);
    expect(f.refs()).toContainEqual(fileEvidence(last, f.repo));
    expect(f.observation().coverage.deferred).toContain(first);
  } finally {
    fs.chmodSync(first, 0o600);
  }
  for (let window = 0; window < 4; window++) expect((await f.sweep()).result.hung).toBe(false);
  expect(new Set(f.refs().map((ref) => ref.ref))).toEqual(new Set(f.paths));
  for (let window = 0; window < 4; window++) expect((await f.sweep()).result.hung).toBe(window === 3);
});

for (const screen of [">", "compaction failed\n>"]) {
  test(`ordinary ${screen.includes("compaction") ? "compaction" : "idle"} stalls resume on Working and permit a later nudge and stall`, async () => {
    const f = coverageFixture(state);
    const world = newWorld();
    world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
    const deps = depsFor(world, f.clock, state.dir, { supervision: { gitActivity: false } });
    const lane = { ...f.lane, pane: "w:p7" };
    await deps.registry.write(lane);
    f.reports.report(lane.key, "milestone", "started", start);
    f.clock.at = start + 20 * 60_000;
    world.screen = screen;
    expect((await freshnessTick(deps, state.dir)).some((act) => act.kind === "stalled")).toBe(true);
    f.clock.at += 60_000;
    world.screen = "Working 1m";
    const resumed = await freshnessTick(deps, state.dir);
    expect(f.reports.read(lane.key)?.state).toBe("running");
    expect(resumed.some((act) => act.kind === "nudged")).toBe(true);
    f.clock.at += 60_000;
    world.screen = ">";
    expect((await freshnessTick(deps, state.dir)).some((act) => act.kind === "stalled")).toBe(true);
  });
}

test("fresh evidence resumes a confirmed stall even while usage remains unknown", async () => {
  const f = coverageFixture(state);
  const source = f.paths[0];
  if (!source) throw new Error("fixture needs a watched file");
  const supervisor = new Supervision(
    { stateDir: state.dir, clock: f.clock, run: git },
    {
      gitActivity: false,
      activityPaths: [source],
      defaults: { tokens: 1 },
    },
  );
  await supervisor.sweep(f.lane, "Working 21m");
  f.clock.at += 20 * 60_000;
  expect((await supervisor.sweep(f.lane, "Working 41m")).state).toBe("stalled");
  fs.writeFileSync(source, "real new evidence");
  f.clock.at += 60_000;
  const changed = await supervisor.sweep(f.lane, "Working 42m");
  expect(changed.state).toBe("running");
  expect(changed.lastEvidenceAt).toBe(new Date(f.clock.at).toISOString());
  expect(f.observation().alerts).toContain("tokens ceiling cannot be checked: usage unavailable");
});

test("normal partial coverage is not a recurring supervision error", async () => {
  const f = coverageFixture(state);
  const world = newWorld();
  world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
  const deps = depsFor(world, f.clock, state.dir, { supervision: { hungAfterMinutes: 1_000 } });
  const lane = { ...f.lane, pane: "w:p7" };
  await deps.registry.write(lane);
  f.reports.report(lane.key, "milestone", "started", start);
  const run: Runner = (argv, options) => (argv[0] === "git" ? git(argv, options) : deps.run(argv, options));
  for (let turn = 0; turn < 8; turn++) {
    f.clock.at = start + turn * 60_000;
    world.screen = `Working ${21 + turn}m`;
    expect((await freshnessTick({ ...deps, run }, state.dir)).some((act) => act.kind === "supervision-error")).toBe(
      false,
    );
    expect((await deps.registry.read(lane.key))?.lastSupervisionError).toBeUndefined();
  }
});
