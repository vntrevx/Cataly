import { afterEach, beforeEach, expect, test } from "bun:test";
import { DeliveryState } from "../src/delivery-state.ts";
import { claimDone, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { pauseLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { resolveTell, tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "fenced-flow",
  title: "tell",
  thread: "none",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: ReturnType<typeof withState>;
let world: World;
const deps = () => depsFor(world, fakeClock(T0 + 30 * 60_000), state.dir, { postAfterMin: 999 });
const store = () => new DeliveryState(deps().registry, lane.key);
beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("an uncertain tell holds nudges, claim notices and objections without losing their state transitions", async () => {
  await tellLane(deps(), lane, "owner request");
  const request = store().read();
  const acts = await freshnessTick(deps(), "/home/test");
  expect(acts.map((act) => act.kind)).toEqual(["held"]);
  expect(acts[0]?.detail).toStartWith("TELL_HELD fenced-flow");
  expect(await claimDone(deps(), lane, "done evidence")).toStartWith("LANE_DONE_CLAIMED");
  const claimed = await deps().registry.read(lane.key);
  if (!claimed) throw new Error("missing claimed lane");
  expect(await objectDone(deps(), claimed, ["still incomplete"])).toStartWith("LANE_NOT_DONE");
  const objected = await deps().registry.read(lane.key);
  expect(objected && statusOf(objected)).toBe("not-done");
  expect(store().read()).toEqual(request);
  expect(sent(world)).toEqual(["owner request"]);
});

test("an unconfirmed automatic nudge also fences a later ordinary tell", async () => {
  expect((await freshnessTick(deps(), "/home/test")).map((act) => act.kind)).toEqual(["nudged"]);
  expect(store().read()?.status).toBe("uncertain");
  expect((await tellLane(deps(), lane, "owner request")).code).toBe(2);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("no update for 30 min");
});

test("an unconfirmed objection notification fences the next task", async () => {
  await objectDone(deps(), lane, ["still incomplete"]);
  expect(store().read()?.status).toBe("uncertain");
  expect((await tellLane(deps(), lane, "new task")).code).toBe(2);
  expect(sent(world)).toEqual(["[LEAD] not done: still incomplete; keep working, claim again when fixed"]);
});

test("a signal that changes under the watch lock can object without reacquiring its own lock", async () => {
  await deps().registry.write({
    ...lane,
    status: "done-claimed",
    claim: { at: new Date(T0).toISOString(), evidence: "done", emitted: true },
  });
  const base = deps();
  let checks = 0;
  const lines = await watchTick({
    ...base,
    run: async (argv, options) => {
      if (argv[0] === "gh") world.prState = ++checks === 1 ? "MERGED" : "OPEN";
      return base.run(argv, options);
    },
  });
  expect(checks).toBe(2);
  expect(lines[0]).toStartWith("LANE_NOT_DONE");
  expect(store().read()?.status).toBe("uncertain");
  expect(sent(world)).toHaveLength(1);
  expect((await tellLane(deps(), lane, "later task")).code).toBe(2);
});

test("an explicit pause still works and resolving a hold does not resume the lane", async () => {
  await tellLane(deps(), lane, "owner request");
  const request = store().read();
  if (!request) throw new Error("missing pending request");
  world.screens = ["input"];
  world.screen = "Goal paused";
  const base = deps();
  const paused = await pauseLane(
    { ...base, config: { ...base.config, agentCommand: ["omo", "{prompt}"] } },
    lane,
    "owner said wait",
  );
  expect(paused.code).toBe(0);
  expect(store().read()).toEqual(request);
  expect((await resolveTell(deps(), lane.key, request.id, "release hold, not pause")).code).toBe(0);
  expect((await tellLane(deps(), lane, "later request")).line).toContain("the lane is paused");
  expect(sent(world)).toEqual(["owner request", "/goal pause"]);
});

test("resolution waits for an in-flight dispatch and never replays it", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const base = deps();
  let first = true;
  const flight = tellLane(
    {
      ...base,
      run: async (argv, options) => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return base.run(argv, options);
      },
    },
    lane,
    "owner request",
  );
  await entered.promise;
  const request = store().read();
  if (!request) throw new Error("missing write-ahead request");
  const resolving = resolveTell(deps(), lane.key, request.id, "operator ends this hold");
  expect(store().read()?.status).toBe("uncertain");
  release.resolve();
  const [sentResult, resolved] = await Promise.all([flight, resolving]);
  expect([sentResult.code, resolved.code]).toEqual([3, 0]);
  expect(store().read()?.status).toBe("released");
  expect(sent(world)).toEqual(["owner request"]);
});
