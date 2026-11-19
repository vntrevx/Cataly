import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import type { Clock, Runner } from "../src/run.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { integrationFixture, options } from "./supervision-integration.fixture.ts";

let state: TestState;
let restore = () => {};
beforeEach(() => {
  state = withState();
});
afterEach(() => {
  restore();
  restore = () => {};
  state.done();
});

for (const heldHung of [true, false]) {
  test(`a discarded freshness sweep cannot ${heldHung ? "resume held hung" : "stall fresh evidence"} or deliver its stale screen`, async () => {
    const f = await integrationFixture(state);
    restore = f.restore;
    const world = newWorld();
    const lane = { ...f.lane, pane: "w:p7", thread: "test-thread" };
    world.panes.push({ pane_id: lane.pane, workspace_id: "w", agent: "omp", agent_status: "working" });
    const deps = depsFor(world, f.clock, state.dir, {
      nudgeAfterMin: 1,
      postAfterMin: 0,
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
      supervision: options,
    });
    const run: Runner = (argv, args) =>
      argv[0] === "git" || argv[0] === "usage" ? f.run(argv, args) : deps.run(argv, args);
    await f.registry.write(lane);
    expect((await f.supervisor().sweep(lane, "Working 21m")).hung).toBe(false);
    if (heldHung) {
      f.clock.at += 60_000;
      expect((await f.supervisor().sweep(lane, "Working 22m")).heldHung).toBe(true);
    }
    f.clock.at += 60_000;
    const timer = heldHung ? "Working 23m" : "Working 22m";
    world.screen = heldHung ? timer : "compaction failed";
    // Changed metadata forces a hash, but these are the same bytes and must not release a held evidence stall.
    writeFileSync(f.source, "first");
    const releasePeer = Promise.withResolvers<void>();
    const resumeStale = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const hold = f.holdAtHash(releasePeer.promise);
    const slowClock: Clock = {
      now: f.clock.now,
      sleep: async () => {
        waiting.resolve();
        await resumeStale.promise;
      },
    };
    const stale = freshnessTick({ ...deps, run, clock: slowClock }, state.dir);
    try {
      await Promise.race([
        waiting.promise,
        stale.then(() => {
          throw new Error("stale sweep never waited to commit its observed candidate");
        }),
      ]);
      expect(hold.free).toBe(true);
      releasePeer.resolve();
      expect((await hold.peer)?.ok).toBe(true);
      // A remains parked in its real delivery-lock wait. B uses the same lock through the complete freshness path.
      if (!heldHung) writeFileSync(f.source, "new evidence during A's wait");
      world.screen = timer;
      await freshnessTick({ ...deps, run }, state.dir);
      expect(f.reports.read(lane.key, { generation: lane.lifecycleEpoch })?.state).toBe(
        heldHung ? "stalled" : "running",
      );
      const committed = f.snapshot();
      const registry = await f.registry.read(lane.key);
      const calls = world.calls.length;
      resumeStale.resolve();
      expect(await stale).toEqual([]);
      expect(f.snapshot()).toEqual(committed);
      expect(await f.registry.read(lane.key)).toEqual(registry);
      expect(world.calls).toHaveLength(calls);
    } finally {
      releasePeer.resolve();
      resumeStale.resolve();
      await stale;
    }
  });
}
