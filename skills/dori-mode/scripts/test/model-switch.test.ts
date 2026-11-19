import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isModelSwitchRequest, type ModelSwitchResult } from "../src/model-switch-state.ts";
import { sent } from "./fakes.ts";
import {
  STARTED,
  KEY,
  HEAD_PANE,
  LANE_PANE,
  LANE_PID,
  OTHER_SESSION,
  NEW,
  head,
  lane,
  writePane,
  registered,
  identity,
  claim,
  changed,
  changes,
  switchTo,
  expectUnchanged,
  state,
  world,
  deps,
  laneFile,
  claimed,
  control,
  modelSwitchSetup,
} from "./model-switch-fixture.ts";

modelSwitchSetup();

test("an idle lane with a paused goal changes model once, recorded from its own native snapshot", async () => {
  control.apply = changes("acme/New-Model");
  const result = await switchTo(NEW);
  expect(result.code).toBe(0);
  expect(claimed).toHaveLength(1);
  const request = claimed[0]!;
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatch(/^MODEL_SWITCHED switch-lane acme\/New-Model snapshot snap-.+ goal left paused/);
  expect(sent(world)).toEqual([`/dori-model-apply ${KEY} ${request.nonce}`]);
  expect(isModelSwitchRequest(request)).toBe(true);
  expect(request).toMatchObject({
    version: 1,
    requested: NEW,
    priorSnapshotId: "snap-launch",
    head: identity(head()),
    target: identity(lane()),
  });
  const native = lane();
  const recorded = await registered();
  // The registry mirrors the native session's actual provider/id, not the requested spelling.
  expect(recorded.model).toBe("acme/New-Model");
  expect(recorded.modelSnapshot).toEqual(native.modelSnapshot);
  expect(recorded.modelReadback).toEqual(native.modelReadback);
  expect(recorded.modelProfileFile).toBe(native.modelProfileFile);
  expect(recorded.modelSwitchRequest).toBeUndefined();
  expect(recorded.status).toBe("paused");
  expect(native.goal.status).toBe("paused");
});

test("an allocated session file need not exist before the first native assistant response", async () => {
  rmSync(laneFile);
  writePane(LANE_PANE, { goal: { status: "none" } });
  const result = await switchTo(NEW);
  expect(result.code).toBe(0);
  expect((await registered()).model).toBe(NEW);
  expect(sent(world)).toHaveLength(1);
  expect(lane().goal.status).toBe("none");
  expect(existsSync(laneFile)).toBe(false);
});

test("native idle alone never overrides an unknown terminal status", async () => {
  const target = world.panes.find((pane) => pane.pane_id === LANE_PANE);
  if (!target) throw new Error("native lane pane missing");
  target.agent_status = "unknown";
  expect((await switchTo(NEW)).code).toBe(2);
  expect(sent(world)).toEqual([]);
  await expectUnchanged();
  target.agent_status = "idle";
  expect((await switchTo(NEW)).code).toBe(0);
  expect((await registered()).model).toBe(NEW);
  expect(sent(world)).toHaveLength(1);
  expect(lane().goal.status).toBe("paused");
});

test("a native change still running is read back until its receipt, never sent again", async () => {
  control.apply = async (key, nonce) => {
    const request = await claim(key, nonce);
    // Past the send's six confirmation polls and into the readback.
    let wait = 9;
    if (request)
      control.ticks = () => {
        if (--wait === 0) changed(request);
      };
  };
  const result = await switchTo(NEW);
  expect(result.code).toBe(0);
  expect(sent(world)).toHaveLength(1);
  expect((await registered()).model).toBe(NEW);
});

test.each(["acme/*", "new-model", "acme/a,b", "acme/new model", "/new-model"])(
  "refuses selector %j before touching any pane",
  async (selector) => {
    const result = await switchTo(selector);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toStartWith(`MODEL_SWITCH_REFUSED ${KEY} cannot switch to`);
    expect(world.calls).toEqual([]);
    await expectUnchanged();
  },
);

const IMPOSTORS: readonly (readonly [string, () => Promise<ModelSwitchResult>])[] = [
  ["another process", () => switchTo(NEW, { ...head(), pid: process.pid + 7 })],
  ["a lane role", () => switchTo(NEW, { ...head(), role: "lane" })],
  ["an earlier head session", () => switchTo(NEW, { ...head(), sessionId: OTHER_SESSION })],
  ["another session file", () => switchTo(NEW, { ...head(), sessionFile: laneFile })],
  ["a restarted head", () => switchTo(NEW, { ...head(), startedAt: "2026-01-01T12:30:00.000Z" })],
  [
    "a head record no live process owns",
    () => {
      writePane(HEAD_PANE, { pid: process.pid + 7 });
      return switchTo(NEW, { ...head(), pid: process.pid });
    },
  ],
  ["a caller in another pane", () => switchTo(NEW, head(), { ...deps, env: { HERDR_PANE_ID: LANE_PANE } })],
  [
    "a lane posing as the head",
    () => switchTo(NEW, { ...lane(), role: "dori", pid: process.pid }, { ...deps, env: { HERDR_PANE_ID: LANE_PANE } }),
  ],
];

test.each(IMPOSTORS)("refuses %s as the head before anything is stored or sent", async (_name, call) => {
  const result = await call();
  expect(result.code).toBe(2);
  expect(result.lines[0]).toContain("caller is not the live native Dori head");
  expect(sent(world)).toEqual([]);
  await expectUnchanged();
});

const REFUSALS: readonly (readonly [string, () => unknown, string])[] = [
  ["a working turn", () => writePane(LANE_PANE, { agentStatus: "working" }), "not idle"],
  ["an open approval", () => writePane(LANE_PANE, { approvalPending: true }), "approval prompt"],
  ["an active goal", () => writePane(LANE_PANE, { goal: { status: "active" } }), `Fix: run dori pause ${KEY} first`],
  ["a blocked goal", () => writePane(LANE_PANE, { goal: { status: "blocked" } }), `Fix: run dori pause ${KEY} first`],
  ["a stale pid", () => writePane(LANE_PANE, { pid: LANE_PID + 7 }), "no trusted live native lane session"],
  [
    "another registered session",
    async () => deps.registry.write({ ...(await registered()), session: OTHER_SESSION }),
    "not the registered session",
  ],
  [
    "another registered session file",
    async () => {
      const other = join(state.dir, "other.jsonl");
      writeFileSync(other, "");
      await deps.registry.write({ ...(await registered()), sessionFile: other });
    },
    "not the registered session",
  ],
  [
    "another registered cwd",
    async () => deps.registry.write({ ...(await registered()), cwd: state.dir }),
    "not the registered session",
  ],
  ["a closed lane", async () => deps.registry.write({ ...(await registered()), closedAt: STARTED }), "is closed"],
  [
    "a native process without the registered profile",
    () => writePane(LANE_PANE, { modelProfileFile: join(state.dir, "model-profiles", "other.json") }),
    "does not own the lane's registered model profile",
  ],
];

test.each(REFUSALS)("refuses %s before anything is stored or sent", async (_name, arrange, reason) => {
  await arrange();
  const result = await switchTo(NEW);
  expect(result.code).toBe(2);
  expect(result.lines.join("\n")).toContain(reason);
  expect(sent(world)).toEqual([]);
  await expectUnchanged();
});

test("nothing is typed into a lane whose shell is in front, and the stored request is withdrawn", async () => {
  const target = world.panes.find((p) => p.pane_id === LANE_PANE);
  if (target) target.foreground = "zsh";
  const result = await switchTo(NEW);
  expect(result.code).toBe(2);
  expect(result.lines[0]).toContain("nothing was typed; request withdrawn");
  expect(sent(world)).toEqual([]);
  await expectUnchanged();
});
