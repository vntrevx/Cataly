import { afterEach, beforeEach, expect, test } from "bun:test";
import { DeliveryState } from "../src/delivery-state.ts";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { tellLane } from "../src/tell.ts";
import { laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
const otherSession = "01a11440-ee81-7f90-b2ed-dcc7d51a0ade";
const store = () => new DeliveryState(f.deps.registry, f.lane.key);
const count = (text: string) => sent(f.world).filter((t) => t === text).length;
const current = async (): Promise<Lane> => {
  const lane = await f.deps.registry.read(f.lane.key);
  if (!lane) throw new Error("missing lane");
  return lane;
};
const parkAndReopen = async (note?: string) => {
  const parked = await parkLane(f.deps, await current(), "owner said wait");
  expect(parked.code).toBe(0);
  return reopenLane(f.deps, parked.lane, note);
};

beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test("an explicit reopen note bypasses an uncertain hold once and leaves that hold exactly as it was", async () => {
  // The idle fixture agent never moves to working, so a real tell leaves an uncertain record.
  const told = await tellLane(f.deps, f.lane, "owner request X");
  expect(told.code).toBe(3);
  const request = store().read();
  expect(request?.status).toBe("uncertain");

  const reopened = await parkAndReopen("operator note Y");
  // An unconfirmed note is a valid reopen outcome: the lane is working and the note was attempted once.
  expect(reopened.code).toBe(3);
  expect(statusOf(reopened.lane)).toBe("working");
  expect(reopened.lines.join("\n")).toContain("note=");
  expect(count("[LEAD] operator note Y")).toBe(1);
  expect(store().read()).toEqual(request);

  const before = sent(f.world).length;
  const later = await tellLane(f.deps, await current(), "automatic follow-up");
  expect(later.code).toBe(2);
  expect(later.line).toStartWith(`TELL_HELD ${f.lane.key}`);
  expect(later.line).toContain(`request=${request?.id}`);
  expect(sent(f.world)).toHaveLength(before);
  expect(store().read()).toEqual(request);
  expect(count("[LEAD] operator note Y")).toBe(1);
});

test("an unconfirmed reopen note without a prior hold creates no fence and is never replayed", async () => {
  expect(store().read()).toBeNull();
  const reopened = await parkAndReopen("operator note Y");
  expect(reopened.code).toBe(3);
  expect(reopened.lines.join("\n")).toContain("note=unconfirmed");
  expect(count("[LEAD] operator note Y")).toBe(1);
  expect(store().read()).toBeNull();

  const told = await tellLane(f.deps, await current(), "next task");
  expect(told.code).toBe(3);
  expect(told.line).not.toStartWith("TELL_HELD");
  expect(count("next task")).toBe(1);
  const own = store().read();
  expect(own).not.toBeNull();
  expect(own?.status).toBe("uncertain");
  expect(own?.session).toEqual({ runtime: "herdr", id: "w1:p8", group: "w1", container: "w1:t8" });
  // The ordinary tell made its own dispatch; the note itself was not sent again.
  expect(count("[LEAD] operator note Y")).toBe(1);
});

test("a freshness nudge through tell never reaches a replacement native session", async () => {
  const reopened = await parkAndReopen();
  expect(reopened.code).toBe(0);
  expect(reopened.lane.lifecycleEpoch).toBeDefined();
  const receipt = readPaneState(f.state.dir, "w1:p8");
  if (!receipt) throw new Error("missing reopened pane receipt");
  expect(receipt.sessionId).toBe(f.session);
  laneState(f.state.dir, "w1:p8", { ...receipt, sessionId: otherSession });
  const before = sent(f.world).length;

  // Past nudgeAfterMin since the reopen stamped lastReplyAt, with the fixture's own sleep.
  const later: FlowDeps = {
    ...f.deps,
    clock: { ...f.deps.clock, now: () => f.deps.clock.now() + (f.deps.config.nudgeAfterMin + 5) * 60_000 },
  };
  await freshnessTick(later, "/home/test");

  expect(sent(f.world)).toHaveLength(before);
  expect(sent(f.world).some((t) => t.includes("no update for"))).toBe(false);
  expect(store().read()?.status).toBe("failed");
});

test("a native close in progress wins over an uncertain hold and changes nothing", async () => {
  const reopened = await parkAndReopen();
  expect(reopened.code).toBe(0);
  expect((await tellLane(f.deps, reopened.lane, "owner request X")).code).toBe(3);
  const request = store().read();
  expect(request?.status).toBe("uncertain");

  // A refused native close leaves the prepared intent on the lane.
  f.failClose();
  const closed = await closeLane(f.deps, await current(), "Done: merged");
  expect(closed.closed).toBe(false);
  const closing = await current();
  expect(closing.nativeCloseIntent).toBeDefined();

  const before = sent(f.world).length;
  const told = await tellLane(f.deps, closing, "another message");
  expect(told.code).toBe(2);
  expect(told.line).toContain("native close is in progress");
  expect(told.line).not.toContain("TELL_HELD");
  expect(sent(f.world)).toHaveLength(before);
  expect(store().read()).toEqual(request);
  expect(await current()).toEqual(closing);
});
