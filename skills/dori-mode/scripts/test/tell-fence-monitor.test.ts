import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../src/boot-monitors.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { monitorPresets } from "../src/monitor-presets.ts";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { type DeliveryRecord, DeliveryState } from "../src/delivery-state.ts";
import { claimDone, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { resolveTell, tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "a-fenced",
  title: "tell",
  thread: "none",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: ReturnType<typeof withState>;
let world: World;
const deps = (now = T0 + 30 * 60_000) => depsFor(world, fakeClock(now), state.dir);
const store = () => new DeliveryState(deps().registry, lane.key);
const orderLanes = (base: FlowDeps) => {
  const list = base.registry.list.bind(base.registry);
  spyOn(base.registry, "list").mockImplementation(async () =>
    (await list()).sort((a, b) => a.key.localeCompare(b.key)),
  );
};
const filter = (name: string) => {
  const setup = readFileSync(new URL("../../references/setup.md", import.meta.url), "utf8");
  const row = setup.split("\n").find((line) => line.startsWith(`| ${name} |`));
  const pattern = row?.match(/`(\^[^`]+)`/)?.[1];
  if (!pattern) throw new Error(`missing documented ${name} monitor filter`);
  return new RegExp(pattern.replaceAll("\\|", "|"));
};
beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [
    { pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" },
    { pane_id: "w:p8", workspace_id: "w", agent: "omo", agent_status: "working" },
  ];
  await deps().registry.write(lane);
});
afterEach(() => {
  mock.restore();
  state.done();
});

test.each([
  ["freshness", "HELD"],
  ["freshness", "DELIVERY-ERROR"],
  ["watch", "LANE_WATCH_ERROR"],
  ["watch", "LANE_NOTIFY_HELD"],
  ["watch", "LANE_NOTIFY_UNCONFIRMED"],
])("canonical %s monitors and doctor probes cover %s", (name, event) => {
  const preset = monitorPresets.find((item) => item.name === name);
  if (!preset) throw new Error(`missing ${name} preset`);
  expect(preset.events).toContain(event);
  expect(new RegExp(preset.filter).test(event)).toBe(true);
  expect(filter(name === "watch" ? "done flow" : name).test(event)).toBe(true);
  const manifest: Manifest = {
    path: join(state.dir, "monitor.json"),
    kind: "omp",
    data: {
      version: 1,
      sessionId: "owner",
      monitors: [{ name, argv: [...preset.argv], cwd: state.dir, filter: `^(?!${event}(?: |$))` }],
    },
  };
  const findings = monitorFilterFindings([manifest], "owner");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("WARN");
  expect(findings[0]?.detail).toContain(`misses probes: ${event};`);
});

test("a working lane's claim hold and later objection reach the lead's documented stdout filter", async () => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  await claimDone(deps(T0), lane, "done evidence");
  const request = store().read();
  if (!request) throw new Error("missing claim notification request");
  expect(request.status).toBe("uncertain");
  expect(stdout.mock.calls.some(([line]) => String(line).startsWith("LANE_NOTIFY_UNCONFIRMED"))).toBe(true);
  stdout.mockClear();
  world.prState = "OPEN";
  const lines = await watchTick(deps());
  expect(lines.some((line) => line.startsWith("LANE_NOT_DONE a-fenced"))).toBe(true);
  const visible = stdout.mock.calls.map(([line]) => String(line)).filter((line) => filter("done flow").test(line));
  expect(visible).toHaveLength(1);
  expect(visible[0]).toStartWith("LANE_NOTIFY_HELD a-fenced");
  expect(visible[0]).toContain(request.id);
  expect(visible[0]).toContain("--resolve");
  expect(statusOf((await deps().registry.read(lane.key)) ?? lane)).toBe("not-done");
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("done claim recorded");
  expect((await resolveTell(deps(), lane.key, request.id, "claim notice inspected; release its hold")).code).toBe(0);
  expect(sent(world)).toHaveLength(1);
  for (const pane of world.panes) pane.agent_status = "idle";
  world.onEnterStatus = "working";
  expect((await tellLane(deps(), lane, "fix the failed signal")).code).toBe(0);
  expect(sent(world)).toHaveLength(2);
  expect(sent(world)[1]).toBe("fix the failed signal");
});

test("a lock-held objection is also visible without waiting or sending", async () => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const held = await withDeliveryLock(deps(), lane.key, () => objectDone(deps(), lane, ["not finished"]));
  expect(held.ok).toBe(true);
  const visible = stdout.mock.calls.map(([line]) => String(line)).filter((line) => filter("done flow").test(line));
  expect(visible[0]).toStartWith("LANE_NOTIFY_HELD a-fenced");
  expect(visible[0]).toContain("delivery lock");
  expect(sent(world)).toEqual([]);
});

test("real freshness stdout exposes a durable hold through its documented monitor filter", async () => {
  await tellLane(deps(), lane, "owner request");
  const request = store().read();
  if (!request) throw new Error("missing request");
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, runtime: "herdr", hooks: {} }));
  const result = await run([
    "env",
    `PATH=${state.dir}`,
    `DORI_CONFIG=${config}`,
    `DORI_STATE_DIR=${state.dir}`,
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "freshness",
    "--loop",
    "0",
  ]);
  expect(result.code).toBe(0);
  const visible = result.out.split("\n").filter((line) => filter("freshness").test(line));
  expect(visible).toHaveLength(1);
  expect(visible[0]).toStartWith("HELD a-fenced TELL_HELD");
  expect(visible[0]).toContain(request.id);
  expect(sent(world)).toEqual(["owner request"]);
  expect(store().read()).toEqual(request);
});

for (const fault of ["corrupt", "write-failure"] as const) {
  const inject = () => {
    if (fault === "corrupt") writeFileSync(store().path, "not json");
    else {
      const write = DeliveryState.prototype.write;
      spyOn(DeliveryState.prototype, "write").mockImplementation(function (
        this: DeliveryState,
        record: DeliveryRecord,
      ) {
        if (this.path === store().path) throw new Error("ENOSPC: delivery state write failed");
        write.call(this, record);
      });
    }
  };
  test(`freshness isolates ${fault} and still nudges and posts another lane`, async () => {
    const report = "[REPORT] z-good | milestone | verified progress";
    world.screen = report;
    const base = depsFor(world, fakeClock(T0 + 30 * 60_000), state.dir, {
      postAfterMin: 1,
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
    });
    orderLanes(base);
    await base.registry.write({ ...lane, key: "z-good", pane: "w:p8", thread: "chat:test/9", lastSeenReport: report });
    inject();
    const acts = await freshnessTick(base, "/home/test");
    expect(acts.map(({ kind, lane: key }) => [kind, key])).toEqual([
      ["delivery-error", lane.key],
      ["nudged", "z-good"],
      ["posted", "z-good"],
    ]);
    expect(filter("freshness").test(`DELIVERY-ERROR ${lane.key} ${acts[0]?.detail}`)).toBe(true);
    expect(acts[0]?.detail).toContain("do not resend");
    expect(world.calls.filter((argv) => argv[2] === "send-text").map((argv) => argv[3])).toEqual(["w:p8"]);
    expect(world.calls.filter((argv) => argv[0] === "notify")).toHaveLength(1);
    if (fault === "corrupt") expect(readFileSync(store().path, "utf8")).toBe("not json");
    else expect(store().read()).toBeNull();
  });

  test(`watch isolates ${fault} without closing the affected lane or skipping the next objection`, async () => {
    const claim = { at: new Date(T0).toISOString(), evidence: "done", emitted: true };
    await deps().registry.write({ ...lane, status: "done-claimed", claim });
    await deps().registry.write({ ...lane, key: "z-good", pane: "w:p8", status: "done-claimed", claim });
    world.prState = "OPEN";
    inject();
    const base = deps();
    orderLanes(base);
    const lines = await watchTick(base);
    expect(lines[0]).toStartWith("LANE_WATCH_ERROR a-fenced");
    expect(lines[0]).toContain("do not resend");
    expect(filter("done flow").test(lines[0] ?? "")).toBe(true);
    expect(lines[1]).toStartWith("LANE_NOT_DONE z-good");
    expect(statusOf((await deps().registry.read(lane.key)) ?? lane)).toBe("not-done");
    expect(world.calls.some((argv) => argv[2] === "close")).toBe(false);
    expect(world.calls.filter((argv) => argv[2] === "send-text").map((argv) => argv[3])).toEqual(["w:p8"]);
  });
}

test("freshness repeats delivery errors only after a reason change or recovery", async () => {
  const base = deps();
  await tellLane(base, lane, "owner request");
  const request = store().read();
  if (!request) throw new Error("missing original request");
  writeFileSync(store().path, "not json");
  const first = await freshnessTick(base, "/home/test");
  expect(first.map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(await freshnessTick(base, "/home/test")).toEqual([]);
  writeFileSync(store().path, "[");
  const changed = await freshnessTick(base, "/home/test");
  expect(changed.map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(changed[0]?.detail).not.toBe(first[0]?.detail);
  expect(sent(world)).toEqual(["owner request"]);
  const repaired = await withDeliveryLock(base, lane.key, async () => store().write(request));
  expect(repaired.ok).toBe(true);
  expect((await freshnessTick(base, "/home/test")).map((act) => act.kind)).toEqual(["held"]);
  await base.registry.update(lane.key, (current) => current && { ...current, lastNudgeAt: 0 });
  writeFileSync(store().path, "not json");
  expect((await freshnessTick(base, "/home/test")).map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(readFileSync(store().path, "utf8")).toBe("not json");
  expect(sent(world)).toEqual(["owner request"]);
});
