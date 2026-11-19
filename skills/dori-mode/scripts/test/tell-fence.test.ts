import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { type DeliveryRecord, DeliveryState } from "../src/delivery-state.ts";
import type { Lane } from "../src/registry.ts";
import { runtimesOf } from "../src/run.ts";
import { resolveTell, tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "tell-fence",
  title: "tell",
  thread: "none",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: ReturnType<typeof withState>;
let world: World;
const deps = () => depsFor(world, fakeClock(T0), state.dir);
const store = () => new DeliveryState(deps().registry, lane.key);
const pending = () => {
  const request = store().read();
  if (request?.status !== "uncertain") throw new Error("expected an uncertain request");
  return request;
};
beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("unconfirmed delivery fences the next tell across registry instances", async () => {
  world.onSendText = () => {
    expect(pending().session).toEqual({ runtime: "herdr", id: "w:p7" });
    expect(pending().openedAt).toBe(lane.openedAt);
  };
  expect((await tellLane(deps(), lane, "first private request")).code).toBe(3);
  const next = await tellLane(deps(), lane, "second request");
  expect(sent(world)).toEqual(["first private request"]);
  expect(next.code).toBe(2);
  expect(next.line).toStartWith("TELL_HELD tell-fence");
  expect(next.line).toContain(pending().id);
  expect(readFileSync(store().path, "utf8")).not.toContain("first private request");
  expect(statSync(store().path).mode & 0o777).toBe(0o600);
  expect(await deps().registry.list()).toHaveLength(1);
});

test("resolution requires the exact request and records only a release, never another send", async () => {
  await tellLane(deps(), lane, "first request");
  const request = pending();
  const before = readFileSync(store().path, "utf8");
  expect((await resolveTell(deps(), lane.key, request.id.slice(0, -1), "abandon hold")).code).toBe(2);
  expect((await resolveTell(deps(), lane.key, request.id, "  ")).code).toBe(2);
  expect(readFileSync(store().path, "utf8")).toBe(before);
  const calls = world.calls.length;
  const resolved = await resolveTell(deps(), lane.key, request.id, "operator abandoned this hold");
  expect(resolved.code).toBe(0);
  expect(resolved.line).toContain("original delivery remains unknown; nothing sent or replayed");
  expect(world.calls).toHaveLength(calls);
  expect(store().read()).toEqual({
    ...request,
    status: "released",
    settledAt: new Date(T0).toISOString(),
    note: "operator abandoned this hold",
  });
  const after = readFileSync(store().path, "utf8");
  expect((await resolveTell(deps(), lane.key, request.id, "second explanation")).code).toBe(0);
  expect(readFileSync(store().path, "utf8")).toBe(after);
});

test("an old resolution cannot select a newer request", async () => {
  await tellLane(deps(), lane, "first request");
  const first = pending().id;
  await resolveTell(deps(), lane.key, first, "release first hold");
  expect((await tellLane(deps(), lane, "new request")).code).toBe(3);
  const second = pending().id;
  expect(second).not.toBe(first);
  expect((await resolveTell(deps(), lane.key, first, "stale operator command")).code).toBe(2);
  expect(pending().id).toBe(second);
  expect((await tellLane(deps(), lane, "third request")).code).toBe(2);
  expect(sent(world)).toEqual(["first request", "new request"]);
});

test("confirmed delivery and proven refusal leave no uncertain fence", async () => {
  world.panes = [];
  expect((await tellLane(deps(), lane, "no agent")).code).toBe(2);
  expect(store().read()?.status).toBe("failed");
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  expect((await tellLane(deps(), lane, "unsafe $(id)")).code).toBe(2);
  expect(store().read()?.status).toBe("failed");
  world.onEnterStatus = "working";
  expect((await tellLane(deps(), lane, "confirmed request")).code).toBe(0);
  expect(store().read()?.status).toBe("confirmed");
  for (const pane of world.panes) pane.agent_status = "idle";
  expect((await tellLane(deps(), lane, "next confirmed request")).code).toBe(0);
  expect(sent(world)).toEqual(["confirmed request", "next confirmed request"]);
});

test("an adapter-reported ambiguous submission leaves an uncertain request across restart", async () => {
  world.onSendText = () => {
    throw new Error("runtime disconnected after accepting text");
  };
  // herdr converts send-text errors into ambiguous outcomes, not exceptions.
  const result = await tellLane(deps(), lane, "first request");
  expect(result.code).toBe(3);
  expect(result.line).toStartWith("TELL_UNCONFIRMED tell-fence");
  const id = pending().id;
  delete world.onSendText;
  expect((await tellLane(deps(), lane, "later request")).line).toContain(id);
  expect(sent(world)).toEqual(["first request"]);
});

test("an unexpected exception after adapter delivery propagates and leaves its fence", async () => {
  const base = deps();
  const runtime = runtimesOf(base).for({ runtime: "herdr", id: "w:p7" });
  const original = runtime.deliver.bind(runtime);
  const deliver = spyOn(runtime, "deliver").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("runtime failed after delivery returned");
  });
  try {
    await expect(tellLane(base, lane, "first request")).rejects.toThrow("runtime failed after delivery returned");
  } finally {
    deliver.mockRestore();
  }
  const request = pending();
  expect((await tellLane(deps(), lane, "later request")).line).toContain(request.id);
  expect(sent(world)).toEqual(["first request"]);
});

test("corrupt durable state stops sends and cannot be silently resolved", async () => {
  writeFileSync(store().path, "{broken");
  await expect(tellLane(deps(), lane, "unsafe to dispatch")).rejects.toThrow();
  await expect(resolveTell(deps(), lane.key, crypto.randomUUID(), "guess")).rejects.toThrow();
  expect(readFileSync(store().path, "utf8")).toBe("{broken");
  expect(world.calls).toEqual([]);
});

test("replacing a registry record cannot discard an older uncertain dispatch", async () => {
  await tellLane(deps(), lane, "old registration request");
  const id = pending().id;
  const replacement = { ...lane, openedAt: new Date(T0 + 1).toISOString(), pane: "w:p8" };
  await deps().registry.write(replacement);
  expect((await tellLane(deps(), replacement, "new registration request")).line).toContain(id);
  expect(pending().session.id).toBe("w:p7");
  expect(sent(world)).toEqual(["old registration request"]);
});

test("two concurrent tells submit only the first while its outcome is uncertain", async () => {
  const results = await Promise.all([
    tellLane(deps(), lane, "first request"),
    tellLane(deps(), lane, "second request"),
  ]);
  expect(results.map((result) => result.code)).toEqual([3, 2]);
  expect(sent(world)).toEqual(["first request"]);
});

test("a write failure before submission sends nothing", async () => {
  const write = spyOn(DeliveryState.prototype, "write").mockImplementation(() => {
    throw new Error("disk full");
  });
  try {
    await expect(tellLane(deps(), lane, "first request")).rejects.toThrow("disk full");
    expect(world.calls).toEqual([]);
    expect(store().read()).toBeNull();
  } finally {
    write.mockRestore();
  }
});

test("a final state write failure leaves the pre-submission fence in place", async () => {
  for (const pane of world.panes) pane.agent_status = "idle";
  world.onEnterStatus = "working";
  const original = DeliveryState.prototype.write;
  const write = spyOn(DeliveryState.prototype, "write").mockImplementation(function (
    this: DeliveryState,
    record: DeliveryRecord,
  ) {
    if (record.status === "confirmed") throw new Error("final state write failed");
    original.call(this, record);
  });
  try {
    await expect(tellLane(deps(), lane, "first request")).rejects.toThrow("final state write failed");
  } finally {
    write.mockRestore();
  }
  expect(pending().status).toBe("uncertain");
  expect((await tellLane(deps(), lane, "second request")).code).toBe(2);
  expect(sent(world)).toEqual(["first request"]);
});
