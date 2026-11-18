import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "demo-lane",
  title: "close safety",
  thread: "chat:team/123",
  pane: "w:p1",
  brief: "/briefs/demo.md",
  done: "closed acme/app#2",
  cwd: "/repo",
  openedAt: new Date(T0).toISOString(),
};
let state: TestState;
let world: World;
const deps = (at = T0) =>
  depsFor(world, fakeClock(at), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const cleanupCalls = () =>
  world.calls.filter((argv) => argv[0] === "notify" || argv.includes("close") || argv.includes("remove"));

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test.each(["dirty", "ahead", "unreadable", "cwd-dirty", "cwd-ahead"])(
  "direct close preserves the lane, session and thread with %s work",
  async (kind) => {
    if (kind.startsWith("cwd-")) world.worktreeList = "worktree /repo\nbranch refs/heads/main";
    if (kind.endsWith("dirty")) world.dirty = " M src/app.ts";
    if (kind.endsWith("ahead")) world.aheadCount = "2";
    if (kind === "unreadable") world.isGitRepo = "false";
    const before = await deps().registry.read(lane.key);

    const result = await closeLane(deps(), lane, "manual");

    expect(result.closed).toBe(false);
    expect(result.lines.join("\n")).toContain(`unpushed work in ${kind.startsWith("cwd-") ? "/repo" : WT}`);
    if (kind === "unreadable") expect(result.lines.join("\n")).toContain("git state unreadable");
    expect(await deps().registry.read(lane.key)).toEqual(before);
    expect(cleanupCalls()).toEqual([]);
  },
);

test("direct close checks only the owned worktree, not the human's dirty checkout", async () => {
  world.dirty = { [WT]: "", "/repo": " M notes/todo.md" };

  expect((await closeLane(deps(), lane, "manual")).closed).toBe(true);
  expect(statusOf((await deps().registry.read(lane.key))!)).toBe("closed");
  expect(world.calls).toContainEqual(["notify", lane.thread, "manual"]);
  expect(world.calls).toContainEqual(["herdr", "pane", "close", "w:p1"]);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
});

test("direct close still permits non-git work", async () => {
  world.worktreeList = "";
  world.isGitRepo = "false";
  expect((await closeLane(deps(), lane, "manual")).closed).toBe(true);
});

test("direct close catches tracked work changed by its Done signal", async () => {
  const base = deps();
  const result = await closeLane(
    {
      ...base,
      run: async (argv, opts) => {
        if (argv[0] === "gh") world.dirty = " M src/app.ts";
        return base.run(argv, opts);
      },
    },
    lane,
    "manual",
  );
  expect(result.closed).toBe(false);
  expect(result.lines.join("\n")).toContain(`unpushed work in ${WT}`);
  expect(statusOf((await base.registry.read(lane.key))!)).toBe("working");
  expect(cleanupCalls()).toEqual([]);
});

test("the watcher preserves a work objection found by the final close recheck", async () => {
  await claimDone(deps(), lane, "finished");
  const base = deps(T0 + 6 * 60_000);
  const lines = await watchTick({
    ...base,
    run: async (argv, opts) => {
      // The initial git check passed, but work changed while the Done signal was read.
      if (argv[0] === "gh") world.dirty = " M src/app.ts";
      return base.run(argv, opts);
    },
  });

  expect(lines.at(-1)).toContain(`unpushed work in ${WT}`);
  const after = await base.registry.read(lane.key);
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons.join("; ")).toContain(`unpushed work in ${WT}`);
  expect(cleanupCalls()).toEqual([]);
});

test("an objection during direct-close git I/O keeps its state and prevents cleanup", async () => {
  const base = deps();
  let pending = true;
  const result = await closeLane(
    {
      ...base,
      run: async (argv, opts) => {
        if (pending && argv[0] === "git") {
          pending = false;
          await objectDone(base, (await base.registry.read(lane.key))!, ["owner needs another change"]);
        }
        return base.run(argv, opts);
      },
    },
    lane,
    "manual",
  );

  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toStartWith("LANE_CHANGED");
  expect((await base.registry.read(lane.key))?.objection?.reasons).toEqual(["owner needs another change"]);
  expect(cleanupCalls()).toEqual([]);
});
