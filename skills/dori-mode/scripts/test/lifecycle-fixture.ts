import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { readPaneState, type PaneState } from "../src/lane-state.ts";
import { createModelProfileFile } from "../src/model-profile.ts";
import { snapshotFor } from "./model-snapshot-fixture.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

export type LifecycleFixture = {
  state: TestState;
  world: World;
  deps: FlowDeps;
  lane: Lane;
  file: string;
  session: string;
  creates: () => number;
  failClose: () => void;
  failStart: (value?: boolean) => void;
  foreign: () => void;
};

export const lifecycleFixture = async (): Promise<LifecycleFixture> => {
  const state = withState();
  const world = newWorld();
  const cwd = join(state.dir, "repo");
  mkdirSync(cwd);
  const sessionsDir = join(state.dir, "sessions-store");
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
  const dir = sessionDirFor(sessionsDir, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T12-00-00-000Z_${session}.jsonl`);
  const snapshot = snapshotFor("fixture/saved");
  const initialProfile = createModelProfileFile(state.dir);
  const nativeModel = {
    modelSnapshot: snapshot,
    modelReadback: {
      requested: snapshot.model,
      observed: snapshot.model,
      status: "matched",
      billing: "unknown",
      source: "native-extension",
      checkedAt: snapshot.capturedAt,
    },
  } satisfies Partial<PaneState>;
  writeFileSync(
    file,
    `${[
      { type: "session", id: session, cwd },
      { type: "custom", customType: "omp-dori:model-snapshot", data: snapshot },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const lane: Lane = {
    key: "lifecycle-lane",
    title: "lifecycle",
    thread: "none",
    pane: "w1:p7",
    tab: "w1:t7",
    brief: join(state.dir, "brief.md"),
    cwd,
    done: "merged acme/app#1",
    openedAt: "2026-01-01T12:00:00.000Z",
    modelProfileFile: initialProfile,
    ...nativeModel,
  };
  const attach = (pane: string, goal: "active" | "paused", pid: number, modelProfileFile: string) => {
    world.panes = world.panes.filter((p) => p.pane_id !== pane);
    world.panes.push({ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle" });
    agentIn(world, pane, pid);
    laneState(state.dir, pane, {
      cwd,
      pid,
      sessionFile: file,
      goal: { status: goal },
      agentStatus: "idle",
      modelProfileFile,
      ...nativeModel,
    });
  };
  attach("w1:p7", "active", 4242, initialProfile);
  world.onSendText = (id, text) => {
    const current = readPaneState(state.dir, id);
    if (current && (text === "/goal pause" || text === "/goal resume"))
      laneState(state.dir, id, { ...current, goal: { status: text === "/goal pause" ? "paused" : "active" } });
  };
  let createCount = 0;
  let closeFails = false;
  let startFails = false;
  let wrongSession = false;
  const clock = {
    ...fakeClock(Date.parse("2026-01-01T13:00:00.000Z")),
    // Concurrent lock waiters must yield to the real session-file stream, not spin in resolved microtasks.
    sleep: async () => {
      await Bun.sleep(1);
    },
  };
  const base = depsFor(world, clock, state.dir, { sessionsDir, defaultCwd: cwd, startupWaitSeconds: 1 });
  const deps: FlowDeps = {
    ...base,
    env: { DORI_CONFIG: join(state.dir, "config.json") },
    run: async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") {
        world.calls.push([...argv]);
        if (closeFails) return { code: 1, out: "", err: "close refused" };
        world.panes = world.panes.filter((p) => p.pane_id !== argv[3]);
        return { code: 0, out: "{}", err: "" };
      }
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        world.calls.push([...argv]);
        createCount++;
        world.panes.push({ pane_id: "w1:p8", workspace_id: "w1", foreground: "bash" });
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p8", workspace_id: "w1", tab_id: "w1:t8" } } }),
          err: "",
        };
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        if (startFails) return { code: 1, out: "", err: "agent start failed" };
        const opened = await deps.registry.read(lane.key);
        if (!opened?.modelProfileFile) throw new Error("reopen fixture missing allocated profile");
        attach("w1:p8", "paused", 4250, opened.modelProfileFile);
        if (wrongSession)
          laneState(state.dir, "w1:p8", { cwd, pid: 4250, sessionId: "foreign", goal: { status: "paused" } });
      }
      return base.run(argv, options);
    },
  };
  await deps.registry.write(lane);
  return {
    state,
    world,
    deps,
    lane,
    file,
    session,
    creates: () => createCount,
    failClose: () => {
      closeFails = true;
    },
    failStart: (value = true) => {
      startFails = value;
    },
    foreign: () => {
      wrongSession = true;
    },
  };
};
