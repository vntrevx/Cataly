import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { allowPolicyOnce } from "../../skills/dori-mode/scripts/src/lane-policy-actions.ts";
import {
  policyBinding,
  prepareLanePolicy,
  writeLanePolicy,
} from "../../skills/dori-mode/scripts/src/lane-policy-store.ts";
import { type FakePi, load, useConfig } from "./fake-pi.ts";
import { nativeComposition } from "../../test/fixtures/omp-native-host/compose.ts";

const saved = new Map<string, string | undefined>();
const sessions: FakePi[] = [];
let stateDir: string;
let binding: string;
let policyFile: string;
let counter = 0;
const blocked = (results: unknown[]): boolean =>
  results.some((value) => typeof value === "object" && value !== null && "block" in value && value.block === true);
const call = (pi: FakePi, command = "sudo true") =>
  pi.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } });
const lane = async (id: string, role: "lane" | "dori" | null = "lane") => {
  const pi = await load({
    session: { id, entries: [] },
    agent: { kind: "main", id },
    ...(role ? { flags: { "dori-role": role } } : {}),
  });
  sessions.push(pi);
  await pi.emit("session_start");
  return pi;
};
const inWorker = (id: string, parentId: string, file: string, parentSession: string) =>
  new Promise<Awaited<ReturnType<typeof nativeComposition>>>((resolve, reject) => {
    const worker = new Worker(new URL("../../test/fixtures/omp-native-host/policy-worker.ts", import.meta.url), {
      workerData: { entry: join(import.meta.dir, "../index.ts"), id, parentId, file, parentSession },
    });
    let result: Awaited<ReturnType<typeof nativeComposition>> | undefined;
    worker.once("message", (value) => {
      result = value;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`native policy worker exited ${code} without a result`));
    });
  });

beforeEach(() => {
  for (const key of [
    "DORI_CONFIG",
    "DORI_STATE_DIR",
    "DORI_LANE_POLICY",
    "HERDR_PANE_ID",
    "HC_TERMINAL_ID",
    "DORI_MANAGED_STARTUP",
  ])
    saved.set(key, process.env[key]);
  stateDir = useConfig("");
  delete process.env["HERDR_PANE_ID"];
  delete process.env["HC_TERMINAL_ID"];
  delete process.env["DORI_MANAGED_STARTUP"];
  const policy = prepareLanePolicy(stateDir, "demo", { denyBash: ["sudo"] });
  if (!policy) throw new Error("expected policy");
  writeLanePolicy(policy);
  binding = policyBinding(policy);
  policyFile = policy.file;
  process.env["DORI_LANE_POLICY"] = binding;
});
afterEach(async () => {
  for (const pi of sessions.splice(0)) await pi.emit("session_shutdown");
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

test("only a configured lane guards bash; plain, lead, and non-bash tools are unchanged", async () => {
  const protectedLane = await lane(`protected-${++counter}`);
  expect(blocked(await call(protectedLane))).toBe(true);
  expect(blocked(await call(protectedLane, "echo safe"))).toBe(false);
  expect(blocked(await protectedLane.emit("tool_call", { toolName: "read", input: { path: "sudo" } }))).toBe(false);
  expect(blocked(await call(await lane(`plain-${++counter}`, null)))).toBe(false);
  expect(blocked(await call(await lane(`lead-${++counter}`, "dori")))).toBe(false);
  delete process.env["DORI_LANE_POLICY"];
  expect(blocked(await call(await lane(`unconfigured-${++counter}`)))).toBe(false);
});

test("subagents and grandchildren inherit their parent policy, never an unrelated process binding", async () => {
  const parent = await lane(`parent-${++counter}`);
  delete process.env["DORI_LANE_POLICY"];
  const child = await load({
    session: { id: "child-session", entries: [] },
    agent: { kind: "sub", id: "policy-child", parentId: parent.ctx().agent.id },
  });
  sessions.push(child);
  await child.emit("session_start");
  expect(blocked(await call(child))).toBe(true);
  const grandchild = await load({
    session: { id: "grandchild-session", entries: [] },
    agent: { kind: "sub", id: "policy-grandchild", parentId: "policy-child" },
  });
  sessions.push(grandchild);
  await grandchild.emit("session_start");
  expect(blocked(await call(grandchild))).toBe(true);
  process.env["DORI_LANE_POLICY"] = binding;
  const unrelated = await load({
    session: { id: "unrelated-session", entries: [] },
    agent: { kind: "sub", id: "unrelated-child", parentId: "not-a-policy-parent" },
  });
  sessions.push(unrelated);
  await unrelated.emit("session_start");
  expect(blocked(await call(unrelated))).toBe(false);
});

test("cold native workers restore parent role and policy, including grandchildren and resumed grants", async () => {
  const entry = join(import.meta.dir, "../index.ts");
  const parent = join(stateDir, "native-parent.jsonl");
  const child = join(stateDir, "native-child.jsonl");
  await nativeComposition([entry], ["parent fixture"], { role: "lane", session: { file: parent } });
  delete process.env["DORI_LANE_POLICY"];
  const denied = await inWorker("worker-child", "Main", child, parent);
  expect(denied.tool.executions).toBe(0);
  expect(denied.tool.error).toContain("LANE_POLICY_BLOCKED");
  expect(denied.entries).toContainEqual(expect.objectContaining({ customType: "omp-dori:role", data: "lane" }));
  expect(denied.entries).toContainEqual(expect.objectContaining({ customType: "omp-dori:lane-policy", data: binding }));
  const grandchild = await inWorker(
    "worker-grandchild",
    "worker-child",
    join(stateDir, "native-grandchild.jsonl"),
    child,
  );
  expect(grandchild.tool.executions).toBe(0);
  expect(grandchild.tool.error).toContain("LANE_POLICY_BLOCKED");
  allowPolicyOnce(binding, "denyBash[0]", "owner approved the exact worker command", Date.now());
  writeFileSync(parent, "corrupt parent after the child has its own recorded binding");
  const resumed = await inWorker("worker-child", "Main", child, parent);
  expect(resumed.tool).toEqual({ executions: 1, approvals: 0, error: undefined });
  expect((await inWorker("worker-child", "Main", child, parent)).tool.error).toContain("LANE_POLICY_BLOCKED");
}, 30_000);

test("cold workers do not adopt a stale environment binding from a plain parent", async () => {
  const parent = join(stateDir, "plain-native-parent.jsonl");
  await nativeComposition([join(import.meta.dir, "../index.ts")], ["plain parent"], { session: { file: parent } });
  const child = await inWorker("plain-worker", "Main", join(stateDir, "plain-native-child.jsonl"), parent);
  expect(child.tool).toEqual({ executions: 1, approvals: 0, error: undefined });
  expect(child.entries.some((entry) => entry.type === "custom" && entry.customType === "omp-dori:lane-policy")).toBe(
    false,
  );
}, 30_000);

test("unconfigured native workers preserve host recovery from unrelated malformed journal lines", async () => {
  delete process.env["DORI_LANE_POLICY"];
  for (const role of [undefined, "lane", "dori"] as const) {
    const parent = join(stateDir, `partial-${role ?? "plain"}-parent.jsonl`);
    await nativeComposition([join(import.meta.dir, "../index.ts")], ["unconfigured parent"], {
      ...(role ? { role } : {}),
      session: { file: parent },
    });
    appendFileSync(parent, "unrelated incomplete journal record\n");
    const child = await inWorker(
      `partial-${role ?? "plain"}-worker`,
      "Main",
      join(stateDir, `partial-${role ?? "plain"}-child.jsonl`),
      parent,
    );
    expect(child.tool).toEqual({ executions: 1, approvals: 0, error: undefined });
    expect(child.entries.some((entry) => entry.type === "custom" && entry.customType === "omp-dori:lane-policy")).toBe(
      false,
    );
  }
}, 30_000);

test("unreadable native parent ancestry cannot silently drop a worker policy", async () => {
  const child = await inWorker(
    "orphan-worker",
    "Main",
    join(stateDir, "orphan-native-child.jsonl"),
    join(stateDir, "missing-parent.jsonl"),
  );
  expect(child.tool.executions).toBe(0);
  expect(child.tool.error).toContain("cannot inherit parent session");
}, 30_000);

test("guarded spawning requires a persisted parent, while unconfigured in-memory sessions stay unchanged", async () => {
  const protectedLane = await lane(`memory-parent-${++counter}`);
  expect(blocked(await protectedLane.emit("before_subagent_spawn"))).toBe(true);
  protectedLane.session.file = join(stateDir, "persisted-parent.jsonl");
  expect(blocked(await protectedLane.emit("before_subagent_spawn"))).toBe(false);
  expect(blocked(await (await lane(`plain-memory-${++counter}`, null)).emit("before_subagent_spawn"))).toBe(false);
});

test("new sessions carry policy, resume restores it, and switching to plain branches clears it", async () => {
  const pi = await lane(`lifecycle-${++counter}`);
  const original = pi.session;
  expect(original.entries).toContainEqual({ type: "custom", customType: "omp-dori:lane-policy", data: binding });
  delete process.env["DORI_LANE_POLICY"];
  pi.session = { id: "fresh-session", entries: [] };
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(blocked(await call(pi))).toBe(true);
  expect(pi.session.entries).toContainEqual({ type: "custom", customType: "omp-dori:lane-policy", data: binding });
  pi.session = { id: "plain-session", entries: [] };
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  expect(blocked(await call(pi))).toBe(false);
  pi.session = original;
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  expect(blocked(await call(pi))).toBe(true);
  const resumed = await load({ session: original, agent: { kind: "main", id: `resumed-${++counter}` } });
  sessions.push(resumed);
  await resumed.emit("session_start");
  expect(blocked(await call(resumed))).toBe(true);
});

test("a historical lane without a policy record cannot adopt a foreign inherited policy on resume", async () => {
  const pi = await load({
    session: { id: "old-unconfigured", entries: [{ type: "custom", customType: "omp-dori:role", data: "lane" }] },
    flags: { "dori-role": "lane" },
    agent: { kind: "main", id: "old-unconfigured" },
  });
  sessions.push(pi);
  await pi.emit("session_start");
  expect(blocked(await call(pi))).toBe(false);
});

test("malformed session bindings, snapshots, and bash inputs fail closed", async () => {
  const pi = await lane(`malformed-${++counter}`);
  expect(blocked(await pi.emit("tool_call", { toolName: "bash", input: {} }))).toBe(true);
  writeFileSync(policyFile, "not json");
  expect(blocked(await call(pi))).toBe(true);
  pi.session = {
    id: "corrupt-record",
    entries: [
      { type: "custom", customType: "omp-dori:role", data: "lane" },
      { type: "custom", customType: "omp-dori:lane-policy", data: null },
    ],
  };
  await pi.emit("session_switch", { reason: "resume" });
  expect(blocked(await call(pi))).toBe(true);
});

test("the real native wrapper blocks before approval or execution, and one-time admission still needs native approval", async () => {
  const entry = join(import.meta.dir, "../index.ts");
  const run = (approvalMode: "yolo" | "always-ask") =>
    nativeComposition([entry], ["policy fixture"], {
      role: "lane",
      bash: { command: "sudo true", approvalMode },
    });
  const denied = await run("always-ask");
  expect(denied.tool.executions).toBe(0);
  expect(denied.tool.approvals).toBe(0);
  expect(denied.tool.error).toContain("LANE_POLICY_BLOCKED");
  allowPolicyOnce(binding, "denyBash[0]", "owner approved", Date.now());
  const stillNeedsApproval = await run("always-ask");
  expect(stillNeedsApproval.tool.executions).toBe(0);
  expect(stillNeedsApproval.tool.approvals).toBe(1);
  expect(stillNeedsApproval.tool.error).toContain("requires approval");
  expect((await run("yolo")).tool.error).toContain("LANE_POLICY_BLOCKED");
  allowPolicyOnce(binding, "denyBash[0]", "owner approved another attempt", Date.now());
  const admitted = await run("yolo");
  expect(admitted.tool).toEqual({ executions: 1, approvals: 0, error: undefined });
});
