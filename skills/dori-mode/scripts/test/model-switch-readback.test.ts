import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PaneState } from "../src/lane-state.ts";
import type { ModelSwitchRequest } from "../src/model-switch-state.ts";
import { type Lane, withStatus } from "../src/registry.ts";
import { sent } from "./fakes.ts";
import {
  STARTED,
  KEY,
  LANE_PANE,
  OTHER_SESSION,
  OLD,
  NEW,
  at,
  readback,
  snapshot,
  writePane,
  registered,
  claim,
  changed,
  changes,
  switchTo,
  expectUnchanged,
  state,
  world,
  deps,
  control,
  modelSwitchSetup,
  lane,
} from "./model-switch-fixture.ts";

modelSwitchSetup();

const MOVES: readonly (readonly [string, (current: Lane) => Lane])[] = [
  ["native session", (current) => ({ ...current, session: OTHER_SESSION })],
  ["session file", (current) => ({ ...current, sessionFile: join(state.dir, "other.jsonl") })],
  ["working directory", (current) => ({ ...current, cwd: join(state.dir, "other-repo") })],
  ["pane", (current) => ({ ...current, sessionRef: { runtime: "herdr", id: "w1:p8" } })],
  ["runtime", (current) => ({ ...current, sessionRef: { runtime: "hc", id: LANE_PANE } })],
  ["profile", (current) => ({ ...current, modelProfileFile: join(state.dir, "other-profile.json") })],
  ["snapshot", (current) => ({ ...current, modelSnapshot: snapshot("snap-other", OLD, "launch", STARTED) })],
  ["generation", (current) => withStatus(current, "paused", "a newer pause", at())],
];

test.each(MOVES)("a changed %s before the registry lock cannot inherit an old receipt", async (_name, move) => {
  const update = deps.registry.update.bind(deps.registry);
  let moved: Lane | undefined;
  deps.registry.update = async (key, next) => {
    if (!moved && lane().modelSwitch?.status === "changed") {
      await update(key, (current) => {
        if (current === null) return null;
        moved = move(current);
        return moved;
      });
    }
    return update(key, next);
  };
  const result = await switchTo(NEW);
  expect(moved).toBeDefined();
  if (!moved) throw new Error("registry identity did not change during the receipt commit");
  expect(result.code).toBe(3);
  const current = await registered();
  expect(current).toEqual(moved);
  expect(current.model).toBe(OLD);
  expect(sent(world)).toHaveLength(1);
});

test("an earlier changed receipt that loses its registry race cannot be overwritten by a new request", async () => {
  control.apply = async (key, nonce) => {
    await claim(key, nonce);
  };
  expect((await switchTo(NEW)).code).toBe(3);
  const request = (await registered()).modelSwitchRequest;
  if (!request) throw new Error("fixture missing accepted pending request");
  changed(request);
  const update = deps.registry.update.bind(deps.registry);
  let moved = false;
  deps.registry.update = async (key, next) => {
    if (!moved) {
      moved = true;
      await update(key, (current) => current && withStatus(current, "paused", "a newer pause", at()));
    }
    return update(key, next);
  };
  control.apply = changes();
  const result = await switchTo("acme/third-model");
  expect(moved).toBe(true);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("new request not sent");
  expect(sent(world)).toHaveLength(1);
  const current = await registered();
  expect(current.model).toBe(OLD);
  expect(current.modelSwitchRequest?.nonce).toBe(request.nonce);
  expect(lane().modelSwitch).toEqual({ nonce: request.nonce, status: "changed" });
});

test("a native session replaced after readback is not mirrored even before registry refresh", async () => {
  const update = deps.registry.update.bind(deps.registry);
  let moved = false;
  deps.registry.update = async (key, next) => {
    if (!moved && lane().modelSwitch?.status === "changed") {
      moved = true;
      writePane(LANE_PANE, { sessionId: OTHER_SESSION });
    }
    return update(key, next);
  };
  const result = await switchTo(NEW);
  expect(moved).toBe(true);
  expect(result.code).toBe(3);
  expect((await registered()).model).toBe(OLD);
  expect((await registered()).modelSnapshot?.id).toBe("snap-launch");
  expect(sent(world)).toHaveLength(1);
});

test("a native refusal is reported with its reason and withdraws the request", async () => {
  control.apply = async (key, nonce) => {
    if (await claim(key, nonce))
      writePane(LANE_PANE, { modelSwitch: { nonce, status: "failed", reason: "queued input is waiting" } });
  };
  const result = await switchTo(NEW);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toStartWith(`MODEL_SWITCH_FAILED ${KEY}`);
  expect(result.lines[0]).toContain("native refused: queued input is waiting; request withdrawn");
  expect(sent(world)).toHaveLength(1);
  await expectUnchanged();
});

const BAD_EVIDENCE: readonly (readonly [string, (request: ModelSwitchRequest) => Partial<PaneState>])[] = [
  [
    "the snapshot from before the request",
    () => ({ modelSnapshot: snapshot("snap-launch", NEW, "idle-switch", at()) }),
  ],
  ["a launch snapshot", (r) => ({ modelSnapshot: snapshot(`snap-${r.nonce}`, NEW, "launch", at()) })],
  [
    "a snapshot requested as another model",
    (r) => ({ modelSnapshot: snapshot(`snap-${r.nonce}`, NEW, "idle-switch", at(), "acme/other-model") }),
  ],
  [
    "another selected model",
    (r) => ({
      modelSnapshot: snapshot(`snap-${r.nonce}`, "acme/other-model", "idle-switch", at(), NEW),
      modelReadback: readback("acme/other-model", at(), NEW),
    }),
  ],
  [
    "a malformed snapshot",
    (r) => ({ modelSnapshot: { ...snapshot(`snap-${r.nonce}`, NEW, "idle-switch", at()), capturedAt: "never" } }),
  ],
  ["a snapshot error", () => ({ modelSnapshotError: "profile overlay drifted" })],
  ["another profile file", () => ({ modelProfileFile: join(state.dir, "model-profiles", "other.json") })],
  ["a mismatched readback", () => ({ modelReadback: { ...readback(NEW, at()), status: "mismatch" } })],
  [
    "an unavailable readback",
    () => ({ modelReadback: { ...readback(NEW, at()), status: "unavailable", observed: null } }),
  ],
  ["a preflight readback", () => ({ modelReadback: { ...readback(NEW, at()), source: "launch-preflight" } })],
  ["a readback of another model", () => ({ modelReadback: readback("acme/other-model", at(), NEW) })],
  ["a readback from before the request", () => ({ modelReadback: readback(NEW, STARTED) })],
];

test.each(BAD_EVIDENCE)("a changed receipt with %s is not recorded", async (_name, patch) => {
  control.apply = changes(undefined, patch);
  const result = await switchTo(NEW);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toStartWith(`MODEL_SWITCH_UNVERIFIED ${KEY}`);
  expect(result.lines[0]).toContain("changed without matching evidence");
  expect(result.lines[0]).toContain("request withdrawn");
  expect(sent(world)).toHaveLength(1);
  await expectUnchanged();
});

test("a lane whose native session moved during the readback is not trusted and its request is withdrawn", async () => {
  control.apply = async (key, nonce) => {
    const request = await claim(key, nonce);
    if (request) changed(request, undefined, { sessionId: OTHER_SESSION });
  };
  const result = await switchTo(NEW);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("the lane's native process or session changed; request withdrawn");
  await expectUnchanged();
});

test("a change is not recorded once its nonce is no longer the pending request", async () => {
  const other = randomUUID();
  control.apply = async (key, nonce) => {
    const request = await claim(key, nonce);
    if (!request) return;
    await deps.registry.update(
      KEY,
      (current) => current && { ...current, modelSwitchRequest: { ...request, nonce: other } },
    );
    changed(request);
  };
  const result = await switchTo(NEW);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("request or target no longer current; registry model unchanged");
  const current = await registered();
  expect(current.model).toBe(OLD);
  expect(current.modelSwitchRequest?.nonce).toBe(other);
});
