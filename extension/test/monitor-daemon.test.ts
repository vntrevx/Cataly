import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MonitorExit, Monitors } from "../monitor.ts";
import { until } from "./fake-pi.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-daemon-"));
  const log = join(root, "runs");
  const current = { session: "daemon-owner" };
  const messages: string[] = [];
  const exits: MonitorExit[] = [];
  const monitors = new Monitors(
    (text) => messages.push(text),
    () => current.session,
    1,
  );
  const argv = [
    process.execPath,
    "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, Date.now() + '\\n'); process.exit(7)`,
  ];
  return {
    root,
    current,
    messages,
    exits,
    monitors,
    argv,
    runs: () => readFileSync(log, "utf8").trim().split("\n").map(Number),
    close: () => {
      monitors.stopAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("daemon retries use increasing backoff and stop once at the configured ceiling", async () => {
  const f = fixture();
  try {
    f.monitors.start("daemon", f.argv, "^NEVER", f.root, f.current.session, {
      mode: "daemon",
      restart: { max: 2, backoffSec: 0.05 },
      onExit: (exit) => f.exits.push(exit),
    });
    await until(() => f.messages.join("\n").includes("restart limit reached"), 2500);
    const runs = f.runs();
    expect(runs).toHaveLength(3);
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(50);
    expect(runs[2]! - runs[1]!).toBeGreaterThanOrEqual(100);
    expect(f.exits.map((exit) => exit.restartAttempt)).toEqual([1, 2, 2]);
    expect(f.exits.at(-1)?.exhausted).toBe(true);
    expect(f.messages.join("\n").match(/restarted/g)).toHaveLength(2);
    expect(f.messages.join("\n").match(/restart limit reached/g)).toHaveLength(1);
    expect(f.monitors.list()).toEqual([]);
  } finally {
    f.close();
  }
});

test("explicit stop cancels a pending daemon restart", async () => {
  const f = fixture();
  try {
    f.monitors.start("daemon", f.argv, ".", f.root, f.current.session, {
      mode: "daemon",
      restart: { max: 2, backoffSec: 0.2 },
      onExit: (exit) => f.exits.push(exit),
    });
    await until(() => f.exits.length === 1);
    expect(f.monitors.list()).toEqual([]);
    expect(f.monitors.list(true)[0]?.backoffUntil).toBeString();
    expect(f.monitors.stop("daemon")).toBe(true);
    await Bun.sleep(300);
    expect(f.runs()).toHaveLength(1);
    expect(f.messages.join("\n")).not.toContain("restarted");
  } finally {
    f.close();
  }
});

test("a pending restart never launches in a different current session", async () => {
  const f = fixture();
  try {
    f.monitors.start("daemon", f.argv, ".", f.root, f.current.session, {
      mode: "daemon",
      restart: { max: 2, backoffSec: 0.1 },
      onExit: (exit) => f.exits.push(exit),
    });
    await until(() => f.exits.length === 1);
    f.current.session = "other-owner";
    await Bun.sleep(200);
    expect(f.runs()).toHaveLength(1);
    expect(f.monitors.list(true)).toEqual([]);
  } finally {
    f.close();
  }
});

test("a failed durable exit receipt cannot authorize another daemon process", async () => {
  const f = fixture();
  try {
    f.monitors.start("daemon", f.argv, ".", f.root, f.current.session, {
      mode: "daemon",
      restart: { max: 2, backoffSec: 0.05 },
      onExit() {
        throw new Error("journal write rejected");
      },
    });
    await until(() => f.messages.join("\n").includes("exit state was not recorded"));
    await Bun.sleep(150);
    expect(f.runs()).toHaveLength(1);
    expect(f.messages.join("\n")).not.toContain("restarted");
  } finally {
    f.close();
  }
});

test.each(["process.exit(0)", "process.kill(process.pid, 'SIGTERM')"])("daemon restarts after %s", async (end) => {
  const f = fixture();
  try {
    const argv = f.argv.map((arg) => arg.replace("process.exit(7)", end));
    f.monitors.start("daemon", argv, ".", f.root, f.current.session, {
      mode: "daemon",
      restart: { max: 1, backoffSec: 0.01 },
      onExit: (exit) => f.exits.push(exit),
    });
    await until(() => f.exits.at(-1)?.exhausted === true);
    expect(f.runs()).toHaveLength(2);
    if (end.includes("SIGTERM")) expect(f.exits.at(-1)?.signal).toBe("SIGTERM");
    else expect(f.exits.at(-1)).toMatchObject({ code: 0, signal: null });
  } finally {
    f.close();
  }
});

test("silence is reported once until output resumes", async () => {
  const f = fixture();
  try {
    f.monitors.start("quiet", ["sleep", "10"], ".", f.root, f.current.session, { silentAfterMin: 0.002 });
    await until(() => f.messages.join("\n").includes("MONITOR_SILENT"), 2000);
    await Bun.sleep(170);
    expect(f.messages.join("\n").match(/MONITOR_SILENT/g)).toHaveLength(1);
  } finally {
    f.close();
  }
});
