import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { holdLines } from "../src/holds.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { resumeLane } from "../src/pause.ts";
import { reopenLane } from "../src/reopen.ts";
import { statusOf } from "../src/registry.ts";
import { laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test("park preserves incomplete and unpushed work, session, thread, reason and resume condition", async () => {
  f.world.prState = "OPEN";
  f.world.dirty = " M work.ts";
  f.world.aheadCount = "2";
  const r = await parkLane(f.deps, f.lane, "owner said wait", "parked", "after review");
  expect(r.code).toBe(0);
  expect(statusOf(r.lane)).toBe("closed");
  expect(r.lane).toMatchObject({
    session: f.session,
    sessionFile: f.file,
    thread: "none",
    hold: { reason: "owner said wait", resumeWhen: "after review" },
    receipt: { outcome: "parked" },
  });
  expect(r.lines.join("\n")).toContain("WARNING unpushed work");
  expect(existsSync(f.file)).toBe(true);
  expect(sent(f.world)).toEqual(["/goal pause"]);
  expect(f.world.calls.some((a) => a.includes("remove") || a[0] === "notify" || a[0] === "gh")).toBe(false);
  expect(f.world.calls.some((a) => a[1] === "tab" && a[2] === "close")).toBe(false);
  expect(holdLines([r.lane])[0]).toContain("state=parked");
  expect(holdLines([r.lane], "other")).toEqual([]);
  expect(await watchTick(f.deps)).toEqual([]);
});

test("failed native pause or approval cannot close or claim the lane parked", async () => {
  delete f.world.onSendText;
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  laneState(f.state.dir, "w1:p7", { cwd: f.deps.config.defaultCwd, sessionFile: f.file, approvalPending: true });
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  expect(f.world.calls.some((a) => a[2] === "close")).toBe(false);
  expect(statusOf((await f.deps.registry.read(f.lane.key)) ?? f.lane)).toBe("working");
});

test("close failure keeps a resumable paused record, never a successful parked receipt", async () => {
  f.failClose();
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  const lane = await f.deps.registry.read(f.lane.key);
  expect(lane).toMatchObject({ status: "paused", session: f.session, sessionFile: f.file });
  expect(lane?.closedAt).toBeUndefined();
  expect(lane?.receipt).toBeUndefined();
});

test("normal close still requires Done; explicit abandonment preserves work without a done receipt", async () => {
  f.world.prState = "OPEN";
  expect((await closeLane(f.deps, f.lane, "close")).closed).toBe(false);
  const r = await parkLane(f.deps, f.lane, "superseded", "abandoned");
  expect(r.code).toBe(0);
  expect(r.lane.receipt).toMatchObject({ outcome: "abandoned" });
  expect(holdLines([r.lane])).toEqual([]);
  expect(f.world.calls.some((a) => a.includes("remove"))).toBe(false);
});

test("reopen resumes exactly the saved OMP session with history and original Done intact", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const r = await reopenLane(f.deps, parked.lane);
  expect(r.code).toBe(0);
  expect(statusOf(r.lane)).toBe("working");
  expect(r.lane).toMatchObject({ session: f.session, done: f.lane.done, pane: "w1:p8", tab: "w1:t8" });
  expect(r.lane.closedAt).toBeUndefined();
  expect(r.lane.receipt).toBeUndefined();
  expect(r.lane.history?.map((h) => h.status)).toContain("closed");
  expect(f.creates()).toBe(1);
  expect(f.world.calls.find((a) => a[2] === "run")?.[4]).toContain(`--resume=${f.file}`);
  expect(readPaneState(f.state.dir, "w1:p8")?.goal.status).toBe("active");
  expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
  expect(holdLines([r.lane])).toEqual([]);
  expect((await reopenLane(f.deps, parked.lane)).code).toBe(3);
  expect(f.creates()).toBe(1);
});

test.each(["registry/stale-model", undefined])(
  "reopen does not replace its native model with registry value %s or the current default",
  async (model) => {
    const lane = { ...f.lane, ...(model === undefined ? {} : { model }) };
    await f.deps.registry.write(lane);
    const parked = await parkLane(f.deps, lane, "wait");
    const deps = {
      ...f.deps,
      config: {
        ...f.deps.config,
        defaultModel: "provider/new-default",
        agentCommand: [
          "omp",
          "--dori-role",
          "lane",
          "--model",
          "{model}",
          "--provider=new-provider",
          "--thinking=high",
          "--no-lsp",
          "{prompt}",
        ],
      },
    };
    const reopened = await reopenLane(deps, parked.lane);
    expect(reopened.code).toBe(0);
    expect(reopened.lane.model).toBe("fixture/saved");
    expect(reopened.lane.modelSnapshot?.model).toEqual({ provider: "fixture", id: "saved" });
    const command = f.world.calls.find((argv) => argv[2] === "run")?.[4];
    expect(command).toContain(`--resume=${f.file}`);
    expect(command).toContain("--no-lsp");
    expect(command).not.toContain("--model=");
    expect(command).not.toContain("--provider=");
    expect(command).not.toContain("--thinking=");
    expect(command).not.toContain("registry/stale-model");
    expect(command).not.toContain("provider/new-default");
    expect(command).not.toContain("{model}");
    expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
  },
);

test("reopen refuses a live model alias in an extension option before creating a pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  await expect(
    reopenLane(
      { ...f.deps, config: { ...f.deps.config, agentCommand: ["omp", "--owner-option={model}", "{prompt}"] } },
      parked.lane,
    ),
  ).rejects.toThrow("cannot resolve {model}");
  expect(f.creates()).toBe(0);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});

test("unknown native model snapshot stays paused and cannot be bypassed by resume", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const deps = {
    ...f.deps,
    run: async (argv: readonly string[]) => {
      const result = await f.deps.run(argv);
      if (argv[0] === "herdr" && argv[2] === "run") {
        const state = readPaneState(f.state.dir, "w1:p8");
        if (!state) throw new Error("missing fixture state");
        const { modelSnapshot: _snapshot, ...unknown } = state;
        laneState(f.state.dir, "w1:p8", { ...unknown, modelSnapshotError: "native snapshot unknown" });
      }
      return result;
    },
  };
  const reopened = await reopenLane(deps, parked.lane);
  expect(reopened.code).toBe(3);
  expect(reopened.lines.join("\n")).toContain("native snapshot unknown");
  expect(reopened.lane.status).toBe("paused");
  expect((await resumeLane(deps, reopened.lane, "explicit resume")).code).toBe(3);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});

test("concurrent reopens create only one pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const results = await Promise.all([reopenLane(f.deps, parked.lane), reopenLane(f.deps, parked.lane)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 3]);
  expect(f.creates()).toBe(1);
});

test("an interrupted park completes using its saved identity after the pane disappears", async () => {
  f.failClose();
  await parkLane(f.deps, f.lane, "wait");
  f.world.panes = [];
  const r = await parkLane(f.deps, f.lane, "wait");
  expect(r.code).toBe(0);
  expect(r.lane.receipt).toMatchObject({ outcome: "parked" });
});

test("wrong file identity is refused before reopening any pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  writeFileSync(f.file, `${JSON.stringify({ type: "session", id: "foreign", cwd: f.deps.config.defaultCwd })}\n`);
  await expect(reopenLane(f.deps, parked.lane)).rejects.toThrow("identity or cwd differs");
  expect(f.creates()).toBe(0);
});

test("wrong resumed session stays paused and receives no goal command", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.foreign();
  const r = await reopenLane(f.deps, parked.lane);
  expect(r.code).toBe(3);
  expect(statusOf(r.lane)).toBe("paused");
  expect(sent(f.world)).toEqual(["/goal pause"]);
  expect(f.creates()).toBe(1);
});
