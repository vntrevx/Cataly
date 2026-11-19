import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeliveryState } from "../src/delivery-state.ts";
import type { Lane } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { resolveTell, tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "tell-process",
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
beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("process exit after submission leaves an exact hold and its dead lock can be recovered", async () => {
  const accepted = join(state.dir, "accepted.txt");
  const script = [
    `import { tellLane } from ${JSON.stringify(join(import.meta.dir, "../src/tell.ts"))};`,
    `import { depsFor, fakeClock, newWorld } from ${JSON.stringify(join(import.meta.dir, "fakes.ts"))};`,
    'import { writeFileSync } from "node:fs";',
    `const lane = ${JSON.stringify(lane)};`,
    "const world = newWorld();",
    `world.panes = ${JSON.stringify(world.panes)};`,
    `world.onSendText = () => { writeFileSync(${JSON.stringify(accepted)}, "accepted"); process.exit(77); };`,
    `await tellLane(depsFor(world, fakeClock(${T0}), ${JSON.stringify(state.dir)}), lane, "first request");`,
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 77, out: "", err: "" });
  expect(readFileSync(accepted, "utf8")).toBe("accepted");
  expect(existsSync(join(deps().registry.dir, `${lane.key}.deliver.lock`))).toBe(true);
  const request = store().read();
  if (!request) throw new Error("write-ahead request did not survive child exit");
  expect(request.status).toBe("uncertain");
  expect((await tellLane(deps(), lane, "later request")).line).toContain(request.id);
  expect(sent(world)).toEqual([]);
  expect((await resolveTell(deps(), lane.key, request.id, "operator ends this hold")).code).toBe(0);
  expect(sent(world)).toEqual([]);
});

test("real CLI inspects and releases an exact hold without runtime access or implicit replay", async () => {
  await tellLane(deps(), lane, "first request");
  const request = store().read();
  if (!request) throw new Error("expected request");
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, runtime: "herdr", hooks: {} }));
  const cli = (...args: string[]) =>
    run([
      "env",
      `PATH=${state.dir}`,
      `DORI_CONFIG=${config}`,
      `DORI_STATE_DIR=${state.dir}`,
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "tell",
      lane.key,
      ...args,
    ]);
  const before = readFileSync(store().path, "utf8");
  const status = await cli("--status");
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out.slice(status.out.indexOf("{")).trim())).toEqual(request);
  expect(readFileSync(store().path, "utf8")).toBe(before);
  expect((await cli("--resolve", crypto.randomUUID(), "--note", "wrong request")).code).toBe(2);
  expect((await cli("--resolve", request.id)).code).toBe(1);
  expect((await cli("--resolve", request.id, "--note", "release", "--text", "never replay this")).code).toBe(1);
  expect((await cli("--status", "--text", "never send this")).code).toBe(1);
  expect(readFileSync(store().path, "utf8")).toBe(before);
  // An uncertain request remains inspectable and resolvable even after its lane has closed.
  await deps().registry.write({ ...lane, status: "closed", closedAt: new Date(T0).toISOString() });
  const resolved = await cli("--resolve", request.id, "--note", "operator abandoned the hold");
  expect(resolved.code).toBe(0);
  expect(resolved.out).toContain("original delivery remains unknown; nothing sent or replayed");
  expect(store().read()?.status).toBe("released");
  const after = readFileSync(store().path, "utf8");
  expect((await cli("--resolve", request.id, "--note", "repeat request")).code).toBe(0);
  expect(readFileSync(store().path, "utf8")).toBe(after);
  expect(sent(world)).toEqual(["first request"]);
});
