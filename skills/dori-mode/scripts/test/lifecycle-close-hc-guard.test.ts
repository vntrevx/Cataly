import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { watchTick } from "../src/done-flow.ts";
import { readPaneState } from "../src/lane-state.ts";
import { sessionFields, withStatus } from "../src/registry.ts";
import { laneState } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let fixture: LifecycleFixture | undefined;
afterEach(() => fixture?.state.done());

const ready = async (agentStatus: "idle" | "working", reopened: boolean) => {
  const f = await lifecycleFixture();
  fixture = f;
  const ref = { runtime: "hc", id: "t7" } as const;
  const pid = 4242;
  const cwd = f.deps.config.defaultCwd;
  const { tab: _tab, ...base } = f.lane;
  const lane = {
    ...base,
    ...sessionFields(ref),
    ...(reopened ? { lifecycleEpoch: "hc-guard-generation" } : {}),
    worktrees: [join(f.state.dir, "owned-worktree")],
  };
  f.world.terminals[ref.id] = hcTerm({
    cwd,
    pid: 4241,
    status: { state: "idle", app: "omp" },
    foreground: { name: "omp", argv: ["omp"], pid },
  });
  laneState(f.state.dir, ref.id, { cwd, pid, sessionId: f.session, sessionFile: f.file, agentStatus });
  const at = new Date(f.deps.clock.now() - 3_600_000).toISOString();
  const claim = withStatus(lane, "done-claimed", "live Done", at, {
    claim: { at, evidence: "live Done", emitted: true },
  });
  await f.deps.registry.write(claim);
  const deps = { ...f.deps, config: { ...f.deps.config, runtime: "hc" as const } };
  f.world.calls.length = 0;
  return { f, deps, ref, pid, claim };
};
const effects = (f: LifecycleFixture) =>
  f.world.calls.filter(([cmd, , verb]) => cmd === "hc" && (verb === "kill" || verb === "rm"));
const removals = (f: LifecycleFixture) =>
  f.world.calls.filter(([cmd, , , kind, verb]) => cmd === "git" && kind === "worktree" && verb === "remove");

test.each([false, true])(
  "hc refuses a working main despite an idle terminal status (reopened=%s)",
  async (reopened) => {
    const { f, deps, claim } = await ready("working", reopened);
    expect(await watchTick(deps)).toEqual([expect.stringContaining("main agent is still working")]);
    expect(effects(f)).toEqual([]);
    expect(removals(f)).toEqual([]);
    expect(await deps.registry.read(claim.key)).toEqual(claim);
  },
);

test.each([false, true])("hc preserves a main awaiting approval (reopened=%s)", async (reopened) => {
  const { f, deps, ref, claim } = await ready("working", reopened);
  const native = readPaneState(f.state.dir, ref.id);
  if (!native) throw new Error("native state is absent");
  laneState(f.state.dir, ref.id, { ...native, approvalPending: true });
  expect(await watchTick(deps)).toEqual([expect.stringContaining("LANE_HELD")]);
  expect(effects(f)).toEqual([]);
  expect(removals(f)).toEqual([]);
  expect(await deps.registry.read(claim.key)).toEqual(claim);
});

test.each([false, true])("hc normal native exit still completes cleanup once (reopened=%s)", async (reopened) => {
  const { f, deps, ref, pid, claim } = await ready("idle", reopened);
  expect(await watchTick(deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key}`)]);
  expect(effects(f)).toEqual([
    ["hc", "--json", "kill", ref.id],
    ["hc", "--json", "rm", ref.id],
  ]);
  expect(f.world.procs?.some((process) => process.pid === pid)).toBe(false);
  expect(removals(f)).toHaveLength(1);
  expect(await watchTick(deps)).toEqual([]);
  expect(removals(f)).toHaveLength(1);
});

test.each([false, true])(
  "hc finished terminal is not proof that its native process exited (reopened=%s)",
  async (reopened) => {
    const { f, deps, ref, pid, claim } = await ready("idle", reopened);
    f.keepProcessAlive();
    expect(await watchTick(deps)).toEqual([expect.stringContaining(`native process ${pid} is still present`)]);
    expect(effects(f)).toEqual([
      ["hc", "--json", "kill", ref.id],
      ["hc", "--json", "rm", ref.id],
    ]);
    expect(f.world.procs?.some((process) => process.pid === pid)).toBe(true);
    expect(removals(f)).toEqual([]);
    expect(await deps.registry.read(claim.key)).toMatchObject({
      status: "done-claimed",
      nativeCloseIntent: { ref, process: { pid } },
    });
    if (f.world.procs) f.world.procs = f.world.procs.filter((process) => process.pid !== pid);
    expect(await watchTick(deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key}`)]);
    expect(effects(f)).toHaveLength(2);
    expect(removals(f)).toHaveLength(1);
  },
);
