import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { paneStatePath, writePaneState, type PaneState } from "../src/lane-state.ts";
import { claimModelSwitch, type ModelSwitchRequest, requestMatchesPane } from "../src/model-switch-state.ts";
import { sent } from "./fakes.ts";
import {
  KEY,
  LANE_PANE,
  LANE_PID,
  OTHER_SESSION,
  NEW,
  at,
  snapshot,
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
  world,
  state,
  deps,
  claimed,
  control,
  modelSwitchSetup,
} from "./model-switch-fixture.ts";

modelSwitchSetup();

test("an unanswered request is withdrawn, so a late apply and a late receipt change nothing", async () => {
  let late: { readonly key: string; readonly nonce: string } | undefined;
  control.apply = (key, nonce) => {
    late = { key, nonce };
  };
  const result = await switchTo(NEW);
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("no native receipt after 8 readbacks; request withdrawn");
  expect(sent(world)).toHaveLength(1);
  await expectUnchanged();
  if (!late) throw new Error("the command was never submitted");
  // The late command finds no request to claim, so it publishes and changes nothing.
  const published: unknown[] = [];
  expect(await claimModelSwitch(deps.registry, late.key, late.nonce, lane(), (r) => published.push(r))).toBeNull();
  expect(published).toEqual([]);
  // A late receipt for that nonce is never recorded; the next request is a new nonce that ignores it.
  writePane(LANE_PANE, {
    modelSnapshot: snapshot("snap-late", NEW, "idle-switch", at()),
    modelSwitch: { nonce: late.nonce, status: "changed" },
  });
  await expectUnchanged();
  control.apply = changes();
  const next = await switchTo(NEW);
  expect(next.code).toBe(0);
  expect(sent(world)).toHaveLength(2);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.nonce).not.toBe(late.nonce);
  expect(claimed[0]?.priorSnapshotId).toBe("snap-late");
  expect((await registered()).modelSnapshot?.id).toBe(`snap-${claimed[0]?.nonce}`);
});

test("an accepted unfinished request stays pending and blocks a new one until its own receipt settles it", async () => {
  control.apply = async (key, nonce) => {
    await claim(key, nonce);
  };
  const first = await switchTo(NEW);
  expect(first.code).toBe(3);
  expect(first.lines[0]).toContain("the native change is still running after 8 readbacks");
  expect(first.lines[0]).toContain("stays pending");
  expect(first.lines[0]).toContain("park/reopen the lane if its owning process exited");
  const request = claimed[0]!;
  expect((await registered()).modelSwitchRequest?.nonce).toBe(request.nonce);

  const blocked = await switchTo("acme/other-model");
  expect(blocked.code).toBe(3);
  expect(blocked.lines[0]).toContain(`earlier request ${request.nonce}`);
  expect(blocked.lines[0]).toContain("new request not sent");
  expect(blocked.lines[1]).toContain("if the owning process exited, park/reopen the lane instead");
  expect(sent(world)).toHaveLength(1);
  expect((await registered()).modelSwitchRequest?.nonce).toBe(request.nonce);

  changed(request);
  const settled = await switchTo(NEW);
  expect(settled.code).toBe(0);
  expect(settled.lines[0]).toStartWith(`MODEL_SWITCH_SETTLED ${KEY} earlier request ${request.nonce}`);
  expect(settled.lines[1]).toContain("already; nothing sent");
  expect(sent(world)).toHaveLength(1);
  const current = await registered();
  expect(current.model).toBe(NEW);
  expect(current.modelSnapshot?.id).toBe(`snap-${request.nonce}`);
  expect(current.modelSwitchRequest).toBeUndefined();
});

test("an unreadable claimed frame keeps the request until its native receipt returns", async () => {
  let accepted: PaneState | undefined;
  control.apply = async (key, nonce) => {
    await claim(key, nonce);
    accepted = lane();
    rmSync(paneStatePath(state.dir, LANE_PANE));
  };
  const first = await switchTo(NEW);
  expect(first.code).toBe(3);
  expect(first.lines[0]).toContain("native state is unreadable");
  expect(first.lines[0]).toContain("stays pending");
  expect(first.lines[0]).toContain("park/reopen the lane if its owning process exited");
  const request = claimed[0]!;
  expect((await registered()).modelSwitchRequest?.nonce).toBe(request.nonce);
  expect(sent(world)).toHaveLength(1);
  if (!accepted) throw new Error("the native command was never claimed");
  writePaneState(state.dir, accepted);
  changed(request);
  const settled = await switchTo(NEW);
  expect(settled.code).toBe(0);
  expect(sent(world)).toHaveLength(1);
  expect((await registered()).modelSnapshot?.id).toBe(`snap-${request.nonce}`);
  expect((await registered()).modelSwitchRequest).toBeUndefined();
});

test("a malformed pending request can never apply and is replaced by a valid one", async () => {
  await deps.registry.write({
    ...(await registered()),
    modelSwitchRequest: { nonce: "not-a-uuid" } as unknown as ModelSwitchRequest,
  });
  const result = await switchTo(NEW);
  expect(result.code).toBe(0);
  expect(result.lines[0]).toContain("earlier request is malformed");
  expect(result.lines[1]).toStartWith(`MODEL_SWITCHED ${KEY} ${NEW}`);
  expect((await registered()).modelSwitchRequest).toBeUndefined();
});

test("the native claim accepts only the pending nonce for its own process and session", async () => {
  const request: ModelSwitchRequest = {
    version: 1,
    nonce: randomUUID(),
    requested: NEW,
    createdAt: at(),
    head: identity(head()),
    target: identity(lane()),
    priorSnapshotId: "snap-launch",
  };
  await deps.registry.write({ ...(await registered()), modelSwitchRequest: request });
  const published: unknown[] = [];
  const publish = (receipt: unknown): void => {
    published.push(receipt);
  };
  expect(await claimModelSwitch(deps.registry, KEY, randomUUID(), lane(), publish)).toBeNull();
  expect(
    await claimModelSwitch(deps.registry, KEY, request.nonce, { ...lane(), pid: LANE_PID + 1 }, publish),
  ).toBeNull();
  expect(
    await claimModelSwitch(deps.registry, KEY, request.nonce, { ...lane(), sessionId: OTHER_SESSION }, publish),
  ).toBeNull();
  expect(await claimModelSwitch(deps.registry, KEY, request.nonce, head(), publish)).toBeNull();
  expect(await claimModelSwitch(deps.registry, "../escape", request.nonce, lane(), publish)).toBeNull();
  expect(published).toEqual([]);
  expect(requestMatchesPane(request, lane())).toBe(true);
  expect(await claimModelSwitch(deps.registry, KEY, request.nonce, lane(), publish)).toEqual(request);
  expect(published).toEqual([{ nonce: request.nonce, status: "changing" }]);
});
