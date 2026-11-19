import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Monitors } from "../monitor";
import { type FakePi, load, until, useConfig } from "./fake-pi";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real child pipes and process lifetimes cannot be driven by the parent's fake clock.
const collect = (
  batchMs = 100,
): {
  messages: string[];
  wakes: boolean[];
  monitors: Monitors;
  current: { session: string };
} => {
  const messages: string[] = [];
  const wakes: boolean[] = [];
  const current = { session: "s1" };
  return {
    messages,
    wakes,
    current,
    monitors: new Monitors(
      (content, delivery) => {
        messages.push(content);
        wakes.push(delivery.wake);
      },
      () => current.session,
      batchMs,
    ),
  };
};

describe("Monitors", () => {
  test("a warning wakes a mixed batch without dropping its notice", async () => {
    const { messages, wakes, monitors } = collect();
    try {
      monitors.start(
        "mixed",
        ["sh", "-c", "printf '%s\n' LANE_WATCH_READY 'WARN disk'; exec sleep 30"],
        ".",
        "/",
        "s1",
      );
      await until(() => messages.length > 0);
      expect(messages).toEqual(["[mixed] LANE_WATCH_READY\n[mixed] WARN disk"]);
      expect(wakes).toEqual([true]);
    } finally {
      monitors.stopAll();
    }
  });

  test("a discarded session's warning cannot wake the current session's notice", async () => {
    const { messages, wakes, monitors, current } = collect(1000);
    try {
      monitors.start("stale", ["sh", "-c", "echo 'WARN stale'; exec sleep 30"], ".", "/", "s1");
      current.session = "s2";
      monitors.start("fresh", ["sh", "-c", "echo LANE_WATCH_READY; exec sleep 30"], ".", "/", "s2");
      await until(() => messages.length > 0);
      expect(messages).toEqual(["[fresh] LANE_WATCH_READY"]);
      expect(wakes).toEqual([false]);
    } finally {
      monitors.stopAll();
    }
  });

  test("drops lines when the session has changed since the monitor started", async () => {
    const { messages, monitors, current } = collect();
    monitors.start("stale", ["sh", "-c", "echo hit; exec sleep 30"], ".", "/", "s1");
    current.session = "s2";
    const { pid } = monitors.start("fresh", ["sh", "-c", "echo hit; exec sleep 30"], ".", "/", "s2");
    await until(() => messages.length > 0);
    expect(messages).toEqual(["[fresh] hit"]);
    monitors.stopAll();
    await until(() => !alive(pid));
  });

  test("delivers only matching stdout/stderr lines, a burst as one message, then the exit", async () => {
    const { messages, monitors } = collect();
    monitors.start(
      "inbox",
      ["sh", "-c", "echo 'msg 1'; echo noise; echo 'msg 2' >&2; echo 'msg 3'"],
      "^msg",
      "/",
      "s1",
    );
    await until(() => messages.join("\n").includes("exited"));
    const lines = messages.join("\n").split("\n");
    expect(lines.filter((line) => !line.includes("exited")).sort()).toEqual([
      "[inbox] msg 1",
      "[inbox] msg 2",
      "[inbox] msg 3",
    ]);
    expect(messages[0]?.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toBe(
      "[inbox] monitor exited (code 0): sh -c echo 'msg 1'; echo noise; echo 'msg 2' >&2; echo 'msg 3'",
    );
    expect(monitors.list()).toEqual([]);
  });

  test("lines far apart arrive as separate messages", async () => {
    const { messages, monitors } = collect();
    // the gap is produced by a real child process, which fake timers cannot drive
    monitors.start("slow", ["sh", "-c", "echo a; sleep 0.4; echo b; exec sleep 5"], ".", "/", "s1");
    await until(() => messages.length >= 2);
    expect(messages).toEqual(["[slow] a", "[slow] b"]);
    monitors.stopAll();
  });

  test("reports a monitor that dies with its exit code", async () => {
    const { messages, wakes, monitors } = collect();
    monitors.start("watch", ["sh", "-c", "exit 3"], ".", "/", "s1");
    await until(() => messages.length > 0);
    expect(messages).toEqual(["[watch] monitor exited (code 3): sh -c exit 3"]);
    expect(wakes).toEqual([true]);
  });

  test("rejects a duplicate name and stops without an exit report", async () => {
    const { messages, monitors } = collect();
    const { pid } = monitors.start("dup", ["sleep", "30"], ".", "/", "s1");
    expect(() => monitors.start("dup", ["sleep", "30"], ".", "/", "s1")).toThrow('monitor "dup" is already running');
    expect(monitors.list().map((m) => m.name)).toEqual(["dup"]);
    expect(monitors.stop("dup")).toBe(true);
    await until(() => !alive(pid));
    // asserting that no exit report arrives: wait past the 100ms batch window of the real child process
    await Bun.sleep(150);
    expect(messages).toEqual([]);
    expect(monitors.stop("dup")).toBe(false);
  });

  test("rejects an invalid filter before spawning", () => {
    const { monitors } = collect();
    expect(() => monitors.start("bad", ["sleep", "30"], "(", "/", "s1")).toThrow();
    expect(monitors.list()).toEqual([]);
  });
});

describe("monitor tool", () => {
  let dori: FakePi;
  beforeEach(async () => {
    useConfig(join(import.meta.dir, "fake-ulw.ts"));
    dori = await load({ session: { id: "dori", entries: [] }, flags: { "dori-role": "dori" } });
    await dori.emit("session_start");
  });

  const run = (pi: FakePi, params: Record<string, unknown>) =>
    pi.tools.get("monitor")?.execute("call", params, undefined, undefined, pi.ctx());

  test.each([
    ["LANE_WATCH_READY", false],
    ["HOST_GUARD_READY", false],
    ["PRESENCE_READY slack", false],
    ["PRESENCE_READY discord event=READY", false],
    ["PRESENCE_READY discord event=RESUMED", false],
    ["PRESENCE_ACK discord seq=7", false],
    ["PENDING-REPORT lane a new [REPORT] line; posting once it holds on the next tick", false],
    ["NUDGED lane 5 min silent, delivery delivered", false],
    ["NUDGED lane 5 min silent, delivery unconfirmed", true],
    ["NUDGED lane 5 min silent, delivery failed", true],
    ["NUDGED lane 5 min silent, delivery delivered extra", true],
    ["NO-REPORT lane report journal has no report", true],
    ["STALE-REPORT lane the last [REPORT] line was already posted", true],
    ["POSTED lane Progress (from the lane's last report): done", true],
    ["POST-FAILED lane thread hook failed (exit 1)", true],
    ["WARN disk", true],
    ["DONE_CLAIMED lane", true],
    ["OBJECTED lane", true],
    ["BLOCKED lane", true],
    ["DISCORD_OWNER_MESSAGE {}", true],
    ["INBOUND_READY", true],
    ["COMPUTE_READY", true],
    ["LANE_WATCH_READY_EXTRA", true],
    ["unexpected output", true],
  ] as const)("routes %s without losing monitor content", async (line, wake) => {
    try {
      await run(dori, {
        op: "start",
        name: "notice",
        argv: ["sh", "-c", "printf '%s\n' \"$1\"; exec sleep 30", "monitor", line],
        filter: ".",
      });
      await until(() => dori.messages.length > 0);
      expect(dori.messages).toEqual([
        { content: `[notice] ${line}`, options: { triggerTurn: wake, deliverAs: wake ? "aside" : "nextTurn" } },
      ]);
    } finally {
      await dori.emit("session_shutdown");
    }
  });

  test("wakes the Dori session with an aside message and stops every monitor at session shutdown", async () => {
    await run(dori, { op: "start", name: "inbox", argv: ["sh", "-c", "echo 'msg hi'; exec sleep 30"], filter: "^msg" });
    await until(() => dori.messages.length > 0);
    expect(dori.messages).toEqual([{ content: "[inbox] msg hi", options: { triggerTurn: true, deliverAs: "aside" } }]);
    const listed = await run(dori, { op: "list" });
    const pid = Number(/pid (\d+)/.exec(listed?.content[0]?.text ?? "")?.[1]);
    expect(alive(pid)).toBe(true);

    await dori.emit("session_shutdown");
    await until(() => !alive(pid));
    expect((await run(dori, { op: "list" }))?.content[0]?.text).toBe("no monitors running");
  });

  test("monitors stop when the Dori session switches away", async () => {
    await run(dori, { op: "start", name: "w", argv: ["sleep", "30"], filter: "." });
    const pid = Number(/pid (\d+)/.exec((await run(dori, { op: "list" }))?.content[0]?.text ?? "")?.[1]);
    dori.session = { id: "plain", entries: [] };
    await dori.emit("session_switch", { type: "session_switch", reason: "resume" });
    await until(() => !alive(pid));
    expect(dori.session.entries).toEqual([]);
    expect(dori.active).not.toContain("monitor");
    await expect(run(dori, { op: "list" })).rejects.toThrow(
      "monitor works only in the Dori session (omp --dori-role dori)",
    );
  });

  test("monitors stop when /tree moves the Dori session to a point before its role was recorded", async () => {
    await run(dori, { op: "start", name: "w", argv: ["sleep", "30"], filter: "." });
    const pid = Number(/pid (\d+)/.exec((await run(dori, { op: "list" }))?.content[0]?.text ?? "")?.[1]);
    dori.session = { id: "dori", entries: [] };
    await dori.emit("session_tree", { type: "session_tree", newLeafId: null });
    await until(() => !alive(pid));
    expect(dori.active).not.toContain("monitor");
  });

  test("refuses to run outside the Dori session", async () => {
    const lane = await load({ session: { id: "lane", entries: [] }, flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    expect(lane.active).not.toContain("monitor");
    await expect(run(lane, { op: "list" })).rejects.toThrow(
      "monitor works only in the Dori session (omp --dori-role dori)",
    );
  });
});
