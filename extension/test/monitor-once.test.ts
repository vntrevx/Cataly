import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readMonitorSet } from "../../src/update/deployment-monitors.ts";
import { dirname, join } from "node:path";
import { type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi";

const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());
const text = async (pi: FakePi) => (await run(pi, { op: "list" })).content[0]!.text;

const exited = (pi: FakePi) => until(() => pi.messages.some((message) => message.content.includes("monitor exited")));

test("a completed once job remains listed but never starts again on resume or new session", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const marker = join(dirname(stateDir), "runs");
  const session: FakeSession = { id: "once-owner", entries: [] };
  const first = await load({ session, flags: { "dori-role": "dori" } });
  let resumed: FakePi | undefined;
  try {
    await first.emit("session_start");
    await run(first, {
      op: "start",
      name: "ci",
      mode: "once",
      argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run")`],
      filter: "^CI_",
    });
    await exited(first);
    expect(readFileSync(marker, "utf8")).toBe("run");
    await first.emit("session_shutdown");
    resumed = await load({ session });
    await resumed.emit("session_start");
    expect(resumed.messages.some((message) => message.content.includes("restored"))).toBe(false);
    expect(await text(resumed)).toContain("ci [mode=once status=exited code=0");
    expect(await text(resumed)).not.toContain("pid ");
    expect(JSON.parse(readFileSync(join(stateDir, "monitors", "once-owner.json"), "utf8")).monitors).toEqual([]);
    resumed.session = { id: "after-once", entries: [] };
    await resumed.emit("session_switch", { type: "session_switch", reason: "new" });
    expect(await text(resumed)).toBe("no monitors running or recorded");
    expect(readFileSync(marker, "utf8")).toBe("run");
  } finally {
    await resumed?.emit("session_shutdown");
    await first.emit("session_shutdown");
  }
});

test.each([
  ["persistent", 0],
  ["persistent", 7],
  ["once", 7],
] as const)("%s exit %s retains restore intent and records the last exit", async (mode, code) => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const marker = join(dirname(stateDir), "runs");
  const session: FakeSession = { id: "retry-owner", entries: [] };
  const first = await load({ session, flags: { "dori-role": "dori" } });
  let resumed: FakePi | undefined;
  try {
    await first.emit("session_start");
    await run(first, {
      op: "start",
      name: "ci",
      ...(mode === "once" ? { mode } : {}),
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run'); process.exit(${code})`,
      ],
      filter: "^CI_",
    });
    await exited(first);
    expect(await text(first)).toContain(`ci [mode=${mode} status=exited code=${code}`);
    expect(await text(first)).toMatch(/signal=none at=[0-9]{4}-/);
    expect(JSON.parse(readFileSync(join(stateDir, "monitors", `${session.id}.json`), "utf8"))).toMatchObject({
      version: mode === "once" ? 2 : 1,
      monitors: [{ name: "ci" }],
    });
    await first.emit("session_shutdown");
    resumed = await load({ session });
    await resumed.emit("session_start");
    await exited(resumed);
    expect(readFileSync(marker, "utf8")).toBe("runrun");
    await run(resumed, { op: "stop", name: "ci" });
    expect(await text(resumed)).toBe("no monitors running or recorded");
    expect(JSON.parse(readFileSync(join(stateDir, "monitors", `${session.id}.json`), "utf8"))).toMatchObject({
      version: 1,
      monitors: [],
    });
  } finally {
    await resumed?.emit("session_shutdown");
    await first.emit("session_shutdown");
  }
});

test("an explicit start may replace a completed once job and stop forgets its terminal record", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const marker = join(dirname(stateDir), "runs");
  const pi = await load({ session: { id: "repeat-owner", entries: [] }, flags: { "dori-role": "dori" } });
  const params = {
    op: "start",
    name: "ci",
    mode: "once",
    argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run')`],
    filter: ".",
  };
  try {
    await pi.emit("session_start");
    await run(pi, params);
    await exited(pi);
    expect(readFileSync(marker, "utf8")).toBe("run");
    pi.messages.length = 0;
    await run(pi, params);
    await exited(pi);
    expect(readFileSync(marker, "utf8")).toBe("runrun");
    expect(await text(pi)).toContain("ci [mode=once status=exited code=0");
    await run(pi, { op: "stop", name: "ci" });
    expect(await text(pi)).toBe("no monitors running or recorded");
    await pi.emit("session_start");
    expect(await text(pi)).toBe("no monitors running or recorded");
    expect(readFileSync(marker, "utf8")).toBe("runrun");
  } finally {
    await pi.emit("session_shutdown");
  }
});

test("active once work holds managed restart and successful completion restores the persistent manifest", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const release = join(dirname(stateDir), "release");
  const session: FakeSession = { id: "managed-once", entries: [] };
  const pi = await load({ session, flags: { "dori-role": "dori" } });
  const manifest = join(stateDir, "monitors", `${session.id}.json`);
  try {
    await pi.emit("session_start");
    pi.api.appendEntry("omp-dori:intake", { path: join(stateDir, "heartbeat"), monitor: "inbound", maxAgeMs: 1000 });
    await run(pi, { op: "start", name: "inbound", argv: ["sleep", "30"], filter: "." });
    await run(pi, {
      op: "start",
      name: "ci",
      mode: "once",
      argv: [
        process.execPath,
        "-e",
        `while (!require('node:fs').existsSync(${JSON.stringify(release)})) await Bun.sleep(10)`,
      ],
      filter: ".",
    });
    expect(await text(pi)).toContain("[mode=once status=running]");
    expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe(2);
    expect(() => readMonitorSet(manifest, session.id, true)).toThrow('waits for once monitor "ci"');
    writeFileSync(release, "go");
    await exited(pi);
    const wanted = readMonitorSet(manifest, session.id, true);
    expect(wanted.version).toBe(1);
    expect(wanted.monitors.map((monitor) => monitor.name)).toEqual(["inbound"]);
    expect(await text(pi)).toContain("ci [mode=once status=exited code=0");
  } finally {
    await pi.emit("session_shutdown");
  }
});

test("a signal exit stays visible and does not masquerade as successful once completion", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const pi = await load({ session: { id: "signal-once", entries: [] }, flags: { "dori-role": "dori" } });
  try {
    await pi.emit("session_start");
    await run(pi, {
      op: "start",
      name: "ci",
      mode: "once",
      argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      filter: ".",
    });
    await exited(pi);
    expect(await text(pi)).toContain("signal=SIGTERM at=");
    expect(await text(pi)).not.toContain("pid ");
    expect(JSON.parse(readFileSync(join(stateDir, "monitors", "signal-once.json"), "utf8"))).toMatchObject({
      version: 2,
      monitors: [{ name: "ci", mode: "once" }],
    });
    await run(pi, { op: "stop", name: "ci" });
  } finally {
    await pi.emit("session_shutdown");
  }
});
