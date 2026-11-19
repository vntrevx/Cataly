import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readPaneState } from "../src/lane-state.ts";
import { resumeLane } from "../src/pause.ts";
import type { Lane } from "../src/registry.ts";
import { laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

for (const opaque of [false, true]) {
  test(
    opaque
      ? "opaque launch receipts retain ordinary resume compatibility"
      : "legacy native resume holds without a saved process profile",
    async () => {
      const { modelProfileFile: _file, modelSnapshot: _snapshot, modelReadback: _proof, ...legacy } = f.lane;
      const lane: Lane = {
        ...legacy,
        status: "paused",
        session: f.session,
        ...(opaque
          ? {
              modelReadback: {
                requested: null,
                observed: null,
                status: "unavailable",
                billing: "unknown",
                source: "launch-preflight",
                checkedAt: new Date(f.deps.clock.now()).toISOString(),
                reason: "opaque launcher",
              },
            }
          : {}),
      };
      await f.deps.registry.write(lane);
      const current = readPaneState(f.state.dir, "w1:p7");
      if (!current) throw new Error("native fixture missing");
      const { modelProfileFile: _profile, modelSnapshot: _saved, modelReadback: _readback, ...native } = current;
      laneState(f.state.dir, "w1:p7", { ...native, goal: { status: "paused" } });
      writeFileSync(f.file, `${JSON.stringify({ type: "session", id: f.session, cwd: f.lane.cwd })}\n`);
      const deps = opaque
        ? { ...f.deps, config: { ...f.deps.config, agentCommand: ["sh", "-c", 'exec omp "$@"', "sh", "{prompt}"] } }
        : f.deps;
      const result = await resumeLane(deps, lane, "explicit resume");
      expect(result.code).toBe(opaque ? 0 : 3);
      expect(sent(f.world)).toEqual(opaque ? ["/goal resume"] : []);
      expect(readPaneState(f.state.dir, "w1:p7")?.goal.status).toBe(opaque ? "active" : "paused");
      if (!opaque) expect(result.lines.join("\n")).toContain("native model snapshot unverified");
    },
  );
}
