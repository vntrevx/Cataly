import { afterEach, beforeEach, expect, test } from "bun:test";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

for (const idle of [false, true]) {
  test(`held hung posts report-only milestones once without repeated STALLED while ${idle ? "idle" : "partially observed"}`, async () => {
    const f = coverageFixture(state);
    const world = newWorld();
    world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
    const deps = depsFor(world, f.clock, state.dir, {
      nudgeAfterMin: 1,
      postAfterMin: 0,
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
      supervision: { hungAfterMinutes: 0, staleAfterMinutes: 0 },
    });
    const lane = { ...f.lane, pane: "w:p7", thread: "test-thread" };
    await deps.registry.write(lane);
    await f.reports.report(lane.key, "milestone", "started", start);
    const run: Runner = (argv, options) => (argv[0] === "git" ? git(argv, options) : deps.run(argv, options));
    const tick = async (turn: number) => {
      f.clock.at = start + turn * 60_000;
      world.screen = idle && turn > 7 ? ">" : `Working ${21 + turn}m`;
      return f.settle(() => freshnessTick({ ...deps, run }, state.dir));
    };
    for (let turn = 0; turn < 7; turn++) await tick(turn);
    expect((await tick(7)).filter((act) => act.kind === "stalled")).toHaveLength(1);
    expect(f.observation().hung).toBe(true);
    const evidenceAt = f.observation().lastEvidenceAt;
    for (let turn = 8; turn < 10; turn++) {
      await f.reports.report(lane.key, "milestone", `report-only ${turn}`, start + turn * 60_000);
      const acts = await tick(turn);
      expect(acts.some((act) => act.kind === "stalled" || act.kind === "nudged")).toBe(false);
      expect(acts.filter((act) => act.kind === "posted").map((act) => act.detail)).toEqual([
        `Progress (from the lane's last report): report-only ${turn}`,
      ]);
      expect(f.reports.read(lane.key)?.state).toBe("stalled");
      expect(f.observation().hung).toBe(true);
      expect(f.observation().lastEvidenceAt).toBe(evidenceAt);
    }
    for (let turn = 10; turn < 13; turn++) {
      const acts = await tick(turn);
      expect(acts.some((act) => ["stalled", "nudged", "posted"].includes(act.kind))).toBe(false);
      expect(f.reports.read(lane.key)?.state).toBe("stalled");
    }
    expect(world.calls.filter((call) => call[0] === "notify")).toHaveLength(3);
  });
}
