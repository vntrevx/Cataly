import { expect, test } from "bun:test";
import { discordWakeBoundEpoch, isDiscordWakePending } from "../src/discord-lane-wake-pending.ts";
import { wakeDiscordLane } from "../src/discord-lane-wake.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { recordExecution, runContext } from "../src/lane-run.ts";
import { parkLane } from "../src/park.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { reopenLane } from "../src/reopen.ts";
import { type Lane, statusOf, withStatus } from "../src/registry.ts";
import { type Execution, type LaneEvent, Reports } from "../src/reports.ts";
import { isRequestId, isRunId } from "../src/request-identity.ts";
import { executable, nativePid, next, wakeFixture } from "./discord-lane-wake-fixture.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const requestId = "discord:100000000000000001:200000000000000002";
const launchRun = "00000000-0000-4000-8000-000000000001";
const parentRun = "00000000-0000-4000-8000-0000000000ff";
const isExecution = (event: LaneEvent): event is Execution => event.type === "execution";
const linux = test.skipIf(process.platform !== "linux");

/** A registered lane of one original request whose launch run already started. */
const sourced = async (deps: FlowDeps, lane: Lane): Promise<Lane> => {
  const launched: Lane = { ...lane, requestId, runId: launchRun };
  await deps.registry.write(launched);
  recordExecution(deps.config.stateDir, launched, deps.clock.now());
  return launched;
};

test("an unsourced reopen keeps its command and journal without request or run", async () => {
  const f = await lifecycleFixture();
  try {
    const parked = await parkLane(f.deps, f.lane, "wait");
    const r = await reopenLane({ ...f.deps, env: { ...f.deps.env, DORI_LANE_RUN: parentRun } }, parked.lane);
    expect(r.code).toBe(0);
    expect(["requestId" in r.lane, "runId" in r.lane]).toEqual([false, false]);
    expect(f.world.calls.flat().some((arg) => arg.includes("DORI_LANE_RUN"))).toBe(false);
    const events = new Reports(f.state.dir).events(f.lane.key);
    expect(events.some((event) => isExecution(event) || "provenance" in event)).toBe(false);
  } finally {
    f.state.done();
  }
});

test("a sourced reopen keeps the request, starts a new run before its process and binds after readback", async () => {
  const f = await lifecycleFixture();
  try {
    const lane = await sourced(f.deps, {
      ...f.lane,
      lastPostedReportDelivery: { state: "unverified", reason: "fixture" },
    });
    const parked = await parkLane(f.deps, lane, "wait");
    expect(parked.code).toBe(0);
    expect([parked.lane.requestId, parked.lane.runId]).toEqual([requestId, launchRun]);
    let atStart: LaneEvent[] = [];
    const deps: FlowDeps = {
      ...f.deps,
      env: { ...f.deps.env, DORI_LANE_RUN: parentRun },
      run: async (argv, options) => {
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run")
          atStart = new Reports(f.state.dir).events(lane.key);
        return f.deps.run(argv, options);
      },
    };
    const r = await reopenLane(deps, parked.lane);
    expect(r.code).toBe(0);
    const current = await f.deps.registry.read(lane.key);
    if (!current?.runId) throw new Error("reopened lane has no run");
    const { runId, lifecycleEpoch: generation } = current;
    expect(current.requestId).toBe(requestId);
    expect([isRunId(runId), isRequestId(runId), runId === launchRun]).toEqual([true, false, false]);
    expect(current.lastPostedReportDelivery).toBeUndefined();
    const command = f.world.calls.find((argv) => argv[2] === "run")?.[4] ?? "";
    expect(command).toStartWith(`DORI_LANE_RUN=${runId} `);
    expect(command).toContain(`--resume=${f.file}`);
    const create = f.world.calls.filter((argv) => argv[1] === "tab" && argv[2] === "create");
    expect(create).toHaveLength(1);
    expect(create.flat()).toContain("DORI_LANE_RUN=");
    expect(create.flat().some((arg) => arg.includes(runId))).toBe(false);
    const started = atStart.filter(isExecution).filter((event) => event.runId === runId);
    expect(started).toEqual([expect.objectContaining({ phase: "started", requestId, generation })]);
    expect(atStart.at(-1)).toMatchObject({ type: "reopen", generation, provenance: { requestId, runId } });
    const nativeRef = { sessionId: f.session, ref: { runtime: "herdr", id: "w1:p8" } } as const;
    const reports = new Reports(f.state.dir);
    expect(
      reports
        .events(lane.key)
        .filter(isExecution)
        .filter((event) => event.runId === runId),
    ).toEqual([started[0], expect.objectContaining({ phase: "bound", requestId, generation, nativeRef })]);
    expect(runContext(reports, current, runId)).toEqual({ generation, provenance: { requestId, runId, nativeRef } });
    // The launch run keeps its own attribution; nothing is re-derived from the reopened lane.
    expect(runContext(reports, current, launchRun)).toEqual({
      generation: undefined,
      provenance: { requestId, runId: launchRun },
    });

    // Pause and resume act on the same process: the request and run stay and nothing new is recorded.
    const recorded = reports.events(lane.key).filter(isExecution).length;
    const paused = await pauseLane(f.deps, r.lane, "hold");
    expect(paused.code).toBe(0);
    const resumed = await resumeLane(f.deps, paused.lane, "go on");
    expect(resumed.code).toBe(0);
    expect([resumed.lane.requestId, resumed.lane.runId]).toEqual([requestId, runId]);
    expect(reports.events(lane.key).filter(isExecution)).toHaveLength(recorded);
  } finally {
    f.state.done();
  }
});

test("a reopen whose lane moves on after start records no native binding for its run", async () => {
  const f = await lifecycleFixture();
  try {
    const lane = await sourced(f.deps, f.lane);
    const parked = await parkLane(f.deps, lane, "wait");
    const deps: FlowDeps = {
      ...f.deps,
      run: async (argv, options) => {
        const result = await f.deps.run(argv, options);
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run")
          await f.deps.registry.update(lane.key, (c) =>
            c ? withStatus(c, statusOf(c), "operator note", c.openedAt) : null,
          );
        return result;
      },
    };
    const r = await reopenLane(deps, parked.lane);
    expect(r.code).toBe(3);
    expect(r.lines[0]).toStartWith(`LANE_CHANGED ${lane.key}`);
    const current = await f.deps.registry.read(lane.key);
    const runs = new Reports(f.state.dir)
      .events(lane.key)
      .filter(isExecution)
      .filter((event) => event.runId === current?.runId);
    expect(runs).toEqual([expect.objectContaining({ phase: "started" })]);
  } finally {
    f.state.done();
  }
});

/** A sourced wake whose startup is attested on a later poll; the fixture's start check sees the bare command. */
const delayedWake = async () => {
  const fixture = await wakeFixture();
  const lane = await sourced(fixture.deps, fixture.lane);
  fixture.control.delayStartup = true;
  const seen = { command: "", atStart: [] as LaneEvent[], create: [] as string[] };
  const deps: FlowDeps = {
    ...fixture.deps,
    run: async (full, options) => {
      if (full[0] === "herdr" && full[4] === "create") seen.create = [...full];
      if (full[0] === "herdr" && full[3] === "pane" && full[4] === "run") {
        seen.command = full[6] ?? "";
        seen.atStart = new Reports(fixture.state.dir).events(lane.key);
        return fixture.deps.run([...full.slice(0, 6), seen.command.replace(/^DORI_LANE_RUN=\S+ /, "")], options);
      }
      return fixture.deps.run(full, options);
    },
  };
  expect((await wakeDiscordLane(deps, lane)).kind).toBe("unconfirmed");
  const binding = await fixture.deps.registry.read(lane.key);
  if (!binding?.runId) throw new Error("missing wake binding");
  fixture.attachStartedPane();
  fixture.control.leaseOwner = nativePid;
  return { fixture, lane, deps, binding, runId: binding.runId, ...seen };
};

linux("a sourced wake starts a new run in its final generation and binds it only at attestation", async () => {
  const { fixture, lane, deps, binding, runId, command, atStart, create } = await delayedWake();
  try {
    expect(isDiscordWakePending(binding.lifecycleEpoch)).toBe(true);
    expect(binding.requestId).toBe(requestId);
    expect([isRunId(runId), runId === launchRun]).toEqual([true, false]);
    expect(command).toStartWith(`DORI_LANE_RUN=${runId} ${executable} `);
    expect(create).toContain("DORI_LANE_RUN=");
    expect(create.some((arg) => arg.includes(runId))).toBe(false);
    const started = atStart.filter(isExecution).filter((event) => event.runId === runId);
    expect(started).toEqual([expect.objectContaining({ phase: "started", requestId })]);
    const generation = started[0]?.generation ?? "";
    // The process may report before attestation, so its run starts in the final generation, not the pending guard.
    expect(binding.lifecycleEpoch).toBe(discordWakeBoundEpoch(generation));
    expect(new Reports(fixture.state.dir).events(lane.key).filter(isExecution)).toHaveLength(2);

    expect(await wakeDiscordLane(deps, binding)).toEqual({ kind: "started", ref: next });
    const current = await fixture.deps.registry.read(lane.key);
    expect([current?.lifecycleEpoch, current?.runId, current?.requestId]).toEqual([generation, runId, requestId]);
    const nativeRef = { sessionId: fixture.session, ref: { runtime: "herdr", id: next.id } } as const;
    const reports = new Reports(fixture.state.dir);
    expect(
      reports
        .events(lane.key)
        .filter(isExecution)
        .filter((event) => event.runId === runId),
    ).toEqual([started[0], expect.objectContaining({ phase: "bound", requestId, generation, nativeRef })]);
    if (current) expect(runContext(reports, current, runId)?.provenance).toEqual({ requestId, runId, nativeRef });
  } finally {
    fixture.state.done();
  }
});

linux("a wake whose lane moves on during attestation records no native binding", async () => {
  const { fixture, lane, deps, binding, runId } = await delayedWake();
  try {
    let moved = false;
    const moving: FlowDeps = {
      ...deps,
      run: async (full, options) => {
        if (!moved && full[0] === "find") {
          moved = true;
          await fixture.deps.registry.update(lane.key, (c) =>
            c ? withStatus(c, statusOf(c), "operator note", c.openedAt) : null,
          );
        }
        return deps.run(full, options);
      },
    };
    expect(await wakeDiscordLane(moving, binding)).toEqual({
      kind: "unconfirmed",
      reason: "the lane changed during startup attestation",
    });
    expect(moved).toBe(true);
    const runs = new Reports(fixture.state.dir)
      .events(lane.key)
      .filter(isExecution)
      .filter((event) => event.runId === runId);
    expect(runs).toEqual([expect.objectContaining({ phase: "started" })]);
  } finally {
    fixture.state.done();
  }
});
