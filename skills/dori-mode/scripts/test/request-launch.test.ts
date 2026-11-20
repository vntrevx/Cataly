import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runContext } from "../src/lane-run.ts";
import { quoteForPane } from "../src/launch-footer.ts";
import { laneStartCommand, startLaunchRun } from "../src/launch-session.ts";
import { launchLane } from "../src/launch.ts";
import { type Lane, Registry, statusOf, withStatus } from "../src/registry.ts";
import { type Execution, type LaneEvent, Reports } from "../src/reports.ts";
import { isRequestId, isRunId } from "../src/request-identity.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const thread = "discord:111111111111111111";
const requestId = `${thread}:222222222222222222`;
const otherRequest = `${thread}:333333333333333333`;
const runA = "00000000-0000-4000-8000-00000000000a";
const runB = "00000000-0000-4000-8000-00000000000b";
const isExecution = (event: LaneEvent): event is Execution => event.type === "execution";

let state: TestState;
let world: World;
let n = 0;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

/** The OMP launch fixture: a herdr pane whose trusted extension record names this launch's own session. */
const launch = async (
  key: string,
  input: { readonly requestId?: string; readonly thread?: string } = {},
  onSleep?: () => Promise<void>,
) => {
  const brief = join(state.dir, `${key}.md`);
  writeFileSync(brief, "# Ship the fixture\n");
  const sessionsDir = join(state.dir, "omp-store");
  const dir = sessionDirFor(sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const sessionId = `01a1b6d8-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const at = "2026-01-01T12:00:03.000Z";
  const sessionFile = join(dir, `2026-01-01T12-00-03-000Z_${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      { type: "session", id: sessionId, timestamp: at, cwd: "/repo" },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `You are the ${key} lane; report as the footer says.` }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  world = newWorld();
  world.screen = "Working (12s)\nprompt\nGoal: ...";
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "omp", agent_status: "working" }];
  agentIn(world, "w:p9");
  laneState(state.dir, "w:p9", { sessionId, sessionFile });
  const clock = fakeClock(T0);
  const seen = { command: "", atStart: [] as LaneEvent[] };
  const base = depsFor(
    world,
    {
      ...clock,
      sleep: async (ms) => {
        clock.at += ms;
        await onSleep?.();
      },
    },
    state.dir,
    { sessionsDir },
  );
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        world.calls.push([...argv]);
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        seen.command = argv.at(-1) ?? "";
        seen.atStart = new Reports(state.dir).events(key);
      }
      return base.run(argv);
    },
  };
  const result = await launchLane(deps, { key, title: "fixture", brief, done: "closed acme/app#3", ...input });
  const lane = await deps.registry.read(key);
  if (!lane) throw new Error(`lane ${key} not registered`);
  return { ...result, ...seen, lane, sessionId };
};

test("an unsourced launch keeps its start command, record and launch activity", async () => {
  const r = await launch("legacy-lane", { thread });
  expect(r.startup).toBe("STARTUP_OK legacy-lane w:p9");
  expect(r.command).toStartWith("CATALY_ASK_LAUNCHED_LANE=legacy-lane omp --dori-role lane ");
  expect(r.command).not.toContain("DORI_LANE_RUN");
  expect(["requestId" in r.lane, "runId" in r.lane]).toEqual([false, false]);
  expect(new Reports(state.dir).events("legacy-lane")).toEqual([
    {
      type: "activity",
      key: "legacy-lane",
      at: new Date(T0).toISOString(),
      state: "running",
      text: "lane launched in w:p9",
    },
  ]);
  const argv = ["omp", "--model", "m", "two words"];
  expect(laneStartCommand({ key: "k", thread: "none" }, argv)).toBe(argv.map(quoteForPane).join(" "));
});

test("a sourced launch records its run before the agent starts and binds the verified session after", async () => {
  const r = await launch("sourced-lane", { requestId });
  expect(r.startup).toBe("STARTUP_OK sourced-lane w:p9");
  const runId = r.lane.runId ?? "";
  expect(r.lane.requestId).toBe(requestId);
  expect([isRunId(runId), isRequestId(runId), runId === requestId]).toEqual([true, false, false]);
  // Clear a stale terminal-server run in the shell; only the OMP process gets the new run.
  expect(r.command).toStartWith(`DORI_LANE_RUN=${runId} omp --dori-role lane `);
  const create = world.calls.find((argv) => argv[1] === "tab" && argv[2] === "create") ?? [];
  expect(create.length).toBeGreaterThan(0);
  expect(create).toContain("DORI_LANE_RUN=");
  expect(create.some((arg) => arg.includes(runId))).toBe(false);
  const started = expect.objectContaining({ type: "execution", phase: "started", requestId, runId });
  const activity = expect.objectContaining({
    type: "activity",
    text: "lane launched in w:p9",
    provenance: { requestId, runId },
  });
  expect(r.atStart).toEqual([started, activity]);
  expect(r.atStart.filter(isExecution).some((event) => "generation" in event)).toBe(false);
  const nativeRef = { sessionId: r.sessionId, ref: { runtime: "herdr", id: "w:p9" } } as const;
  expect(new Reports(state.dir).events("sourced-lane")).toEqual([
    started,
    activity,
    expect.objectContaining({ type: "execution", phase: "bound", requestId, runId, nativeRef }),
  ]);
  expect(runContext(new Reports(state.dir), r.lane, runId)).toEqual({
    generation: undefined,
    provenance: { requestId, runId, nativeRef },
  });
});

test("one thread serves different real requests through separate lanes and runs", async () => {
  const first = await launch("first-request", { thread, requestId });
  const second = await launch("second-request", { thread, requestId: otherRequest });
  expect([first.lane.thread, second.lane.thread]).toEqual([thread, thread]);
  expect([first.lane.requestId, second.lane.requestId]).toEqual([requestId, otherRequest]);
  expect(first.lane.runId).not.toBe(second.lane.runId);
  if (!first.lane.runId || !second.lane.runId) throw new Error("missing launch run");
  expect(first.command).toStartWith(`CATALY_ASK_LAUNCHED_LANE=first-request DORI_LANE_RUN=${first.lane.runId} omp `);
  expect(second.command).toStartWith(`CATALY_ASK_LAUNCHED_LANE=second-request DORI_LANE_RUN=${second.lane.runId} omp `);
  for (const [key, request, run] of [
    ["first-request", requestId, first.lane.runId],
    ["second-request", otherRequest, second.lane.runId],
  ] as const) {
    const executions = new Reports(state.dir).events(key).filter(isExecution);
    expect(executions.map((e) => [e.phase, e.requestId, e.runId])).toEqual([
      ["started", request, run],
      ["bound", request, run],
    ]);
  }
});

test("a lane that changes generation during startup gets no native binding", async () => {
  let moved = false;
  const r = await launch("moved-lane", { requestId }, async () => {
    if (moved) return;
    moved = true;
    await new Registry(state.dir).update("moved-lane", (c) =>
      c ? withStatus(c, statusOf(c), "operator note", c.openedAt) : null,
    );
  });
  expect(r.startup).toBe("STARTUP_OK moved-lane w:p9");
  expect(new Reports(state.dir).events("moved-lane").filter(isExecution)).toEqual([
    expect.objectContaining({ phase: "started", runId: r.lane.runId }),
  ]);
});

test("a run start is refused for a lane whose run or generation moved on", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const lane: Lane = {
    key: "stale-run",
    title: "t",
    thread: "none",
    brief: "/brief",
    done: "closed acme/app#3",
    openedAt: new Date(T0).toISOString(),
    requestId,
    runId: runA,
  };
  await deps.registry.write(lane);
  expect(await startLaunchRun(deps, { ...lane, runId: runB })).toBeNull();
  expect(await startLaunchRun(deps, { ...lane, openedAt: new Date(T0 + 1).toISOString() })).toBeNull();
  expect(new Reports(state.dir).events(lane.key)).toEqual([]);
  expect(await startLaunchRun(deps, lane)).toEqual({ requestId, runId: runA });
});

// POSIX-only: the real shell applies the terminal server's inherited environment plus create overrides.
test.skipIf(process.platform === "win32")(
  "a stale terminal-server run is cleared before process-only launch",
  async () => {
    const r = await launch("server-env", { requestId });
    const create = world.calls.find((argv) => argv[1] === "tab" && argv[2] === "create") ?? [];
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", DORI_LANE_RUN: runA };
    for (let i = 0; i < create.length - 1; i++) {
      if (create[i] !== "--env") continue;
      const field = create[++i] ?? "";
      const at = field.indexOf("=");
      env[field.slice(0, at)] = field.slice(at + 1);
    }
    const probe = [process.execPath, "-e", "console.log(JSON.stringify(process.env.DORI_LANE_RUN))"];
    const start = laneStartCommand(r.lane, probe);
    const restart = probe.map(quoteForPane).join(" ");
    const child = Bun.spawnSync(["sh", "-c", `${start}; ${restart}`], { cwd: state.dir, env });
    expect(child.exitCode).toBe(0);
    expect(
      child.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([r.lane.runId, ""]);
  },
);
