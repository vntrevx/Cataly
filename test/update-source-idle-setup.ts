import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePaneState, type PaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import type { RuntimeIdentity } from "../src/update/deployment-types.ts";
import { sourceFixture } from "./update-source-setup.ts";

export async function idleFixture() {
  const f = sourceFixture();
  const activity = f.config.activityFiles[0]!;
  const receiver = join(f.root, "receiver.ts");
  writeFileSync(
    receiver,
    `
import { inboundActivity } from ${JSON.stringify(resolve(import.meta.dir, "../src/update/source-activity.ts"))};
let clock = Date.now() - 1_900_000;
const writer = inboundActivity(process.argv[2], "discord", () => clock);
writer.healthy();
let available = true, automatic = true;
clock = Date.now(); writer.healthy();
process.on("message", (message) => {
  clock = Date.now();
  if (message === "received") writer.received();
  else if (message === "freeze") automatic = false;
  else if (message === "unavailable") { available = false; writer.unavailable(); }
  else if (message === "healthy") { available = true; automatic = true; writer.healthy(); }
  else if (message === "stale" || message === "future") {
    automatic = false; clock += message === "stale" ? -${f.config.activityMaxAgeMs + 10_000} : 100_000; writer.healthy();
  }
  process.send?.({ ack: message });
});
const timer = setInterval(() => { if (automatic && available) { clock = Date.now(); writer.healthy(); } }, 1000);
process.on("SIGTERM", () => { clearInterval(timer); writer.close(); process.exit(0); });
process.send?.({ ready: true });
`,
  );
  const leadPath = join(f.root, "lead.ts");
  writeFileSync(
    leadPath,
    `
const receiver = Bun.spawn([process.execPath, ${JSON.stringify(receiver)}, ${JSON.stringify(activity)}], {
  stdin: "ignore", stdout: "ignore", stderr: "inherit", ipc(message) { process.send?.(message); },
});
const timer = setInterval(() => {}, 1000);
process.on("message", async message => {
  if (message === "stop-receiver") {
    receiver.kill("SIGTERM"); await receiver.exited; process.send?.({ ack: message });
  } else receiver.send(message);
});
process.on("SIGTERM", async () => {
  clearInterval(timer); if (receiver.exitCode === null) receiver.kill("SIGTERM");
  await receiver.exited; process.exit(0);
});
`,
  );
  const ready = Promise.withResolvers<void>();
  const acknowledgements = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const lead = Bun.spawn([process.execPath, leadPath], {
    env: { HOME: f.config.deployment.home, PATH: process.env["PATH"] },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    ipc(message: unknown) {
      if (!message || typeof message !== "object") return;
      if ("ready" in message && message.ready === true) ready.resolve();
      if ("ack" in message && typeof message.ack === "string") {
        const reply = acknowledgements.get(message.ack);
        acknowledgements.delete(message.ack);
        reply?.resolve();
      }
    },
  });
  const stderr = new Response(lead.stderr).text();
  void lead.exited.then(async (code) => {
    const failure = new Error(`fixture lead exited ${code}: ${await stderr}`);
    ready.reject(failure);
    for (const reply of acknowledgements.values()) reply.reject(failure);
  });
  const timer = setTimeout(() => ready.reject(new Error("activity fixture did not become ready")), 3000);
  try {
    await ready.promise;
  } catch (error) {
    lead.kill("SIGTERM");
    await lead.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const identity = processIdentity(lead.pid);
  if (!identity) {
    lead.kill("SIGTERM");
    await lead.exited;
    throw new Error("fixture lead has no process identity");
  }
  const deployment = f.config.deployment;
  const runtime: RuntimeIdentity = {
    ...identity,
    pane: deployment.pane,
    role: "dori",
    sessionId: deployment.sessionId,
    sessionFile: join(f.root, "private-session-not-opened.jsonl"),
    startedAt: new Date().toISOString(),
    cwd: deployment.liveSource,
  };
  const state: PaneState = {
    paneId: runtime.pane,
    role: "dori",
    sessionId: runtime.sessionId,
    sessionFile: runtime.sessionFile,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    updatedAt: runtime.startedAt,
    cwd: runtime.cwd,
    goal: { status: "active" },
    approvalPending: false,
    agentStatus: "idle",
  };
  writePaneState(deployment.stateDir, state);
  const manifest = {
    version: 1,
    sessionId: runtime.sessionId,
    monitors: [{ name: "discord", argv: [process.execPath, receiver, activity], filter: ".*", cwd: f.root }],
    intake: { monitor: "discord", path: `${activity}.heartbeat`, maxAgeMs: 90_000 },
  };
  const desired = join(deployment.stateDir, "monitors", `${encodeURIComponent(runtime.sessionId)}.json`);
  saveDeploymentJson(desired, manifest);
  return {
    ...f,
    activity,
    runtime,
    state,
    desired,
    manifest,
    send: async (message: "received" | "unavailable" | "healthy" | "stale" | "future" | "freeze" | "stop-receiver") => {
      const reply = Promise.withResolvers<void>();
      acknowledgements.set(message, reply);
      lead.send(message);
      await reply.promise;
    },
    close: async () => {
      lead.kill("SIGTERM");
      await lead.exited;
    },
  };
}
