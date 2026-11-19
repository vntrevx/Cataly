import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { syncRegistry } from "../src/sync.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

for (const priorSessions of [null, "invalid", [42], [""]])
  test(`sync isolates damaged history ${JSON.stringify(priorSessions)}`, async () => {
    const state = withState();
    try {
      const world = newWorld();
      const now = Date.parse("2026-01-01T12:00:00Z");
      const deps = depsFor(world, fakeClock(now), state.dir);
      const ids = ["01a11440-ee81-7f90-b2ed-dcc7d51a0adf", "01a11440-ee81-7f90-b2ed-dcc7d51a0ae2"];
      world.panes = ["w:p1", "w:p2"].map((pane_id) => ({
        pane_id,
        workspace_id: "w",
        agent: "omp",
        agent_status: "idle",
        cwd: "/repo",
      }));
      for (const [i, key] of ["damaged", "healthy"].entries()) {
        const pane = world.panes[i]!.pane_id;
        const pid = 4242 + i * 100;
        agentIn(world, pane, pid);
        laneState(state.dir, pane, { pid, sessionId: ids[i]! });
        await deps.registry.write(
          JSON.parse(
            JSON.stringify({
              key,
              title: key,
              thread: "none",
              pane,
              brief: "/brief",
              done: "file /done",
              openedAt: new Date(now).toISOString(),
              session: "old-binding",
              ...(i === 0 ? { priorSessions } : {}),
            }),
          ),
        );
      }
      const before = readFileSync(deps.registry.path("damaged"), "utf8");
      const result = await syncRegistry(deps, true);
      expect(result.rows).toHaveLength(2);
      expect(result.drift).toContain("damaged: invalid prior session bindings; registry unchanged");
      expect(readFileSync(deps.registry.path("damaged"), "utf8")).toBe(before);
      expect(await deps.registry.read("healthy")).toMatchObject({ session: ids[1], priorSessions: ["old-binding"] });
    } finally {
      state.done();
    }
  });
