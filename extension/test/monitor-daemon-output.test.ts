import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MonitorExit, Monitors } from "../monitor.ts";
import { until } from "./fake-pi.ts";

test("filtered partial stderr bytes prevent silence and rearm one alert after a quiet spell", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-daemon-output-"));
  const ready = join(root, "ready");
  const pause = join(root, "pause");
  const rearm = join(root, "rearm");
  const messages: string[] = [];
  const monitors = new Monitors(
    (text) => messages.push(text),
    () => "owner",
    1,
  );
  try {
    monitors.start(
      "raw",
      [
        process.execPath,
        "-e",
        `const fs = require('node:fs'); while (!fs.existsSync(${JSON.stringify(pause)})) { process.stderr.write('ignored'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(25); } while (!fs.existsSync(${JSON.stringify(rearm)})) await Bun.sleep(10); process.stderr.write('again'); await Bun.sleep(10000);`,
      ],
      "^MATCH$",
      root,
      "owner",
      { silentAfterMin: 0.003 },
    );
    await until(() => existsSync(ready));
    messages.length = 0;
    await Bun.sleep(350);
    expect(messages.join("\n")).not.toContain("MONITOR_SILENT");
    writeFileSync(pause, "pause");
    await until(() => messages.join("\n").includes("MONITOR_SILENT"));
    await Bun.sleep(220);
    expect(messages.join("\n").match(/MONITOR_SILENT/g)).toHaveLength(1);
    writeFileSync(rearm, "go");
    await until(() => (messages.join("\n").match(/MONITOR_SILENT/g) ?? []).length === 2);
    expect(messages.join("\n")).not.toContain("ignored");
    expect(monitors.list()).toHaveLength(1);
  } finally {
    monitors.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vanished executable records a failed spawn without inventing an exit code", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-daemon-spawn-"));
  const executable = join(root, "child");
  const marker = join(root, "runs");
  symlinkSync(process.execPath, executable);
  const exits: MonitorExit[] = [];
  const messages: string[] = [];
  const monitors = new Monitors(
    (text) => messages.push(text),
    () => "owner",
    1,
  );
  try {
    monitors.start(
      "gone",
      [executable, "-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run'); process.exit(7)`],
      ".",
      root,
      "owner",
      {
        mode: "daemon",
        restart: { max: 1, backoffSec: 0.15 },
        onExit: (exit) => exits.push(exit),
      },
    );
    await until(() => exits.length === 1);
    unlinkSync(executable);
    await until(() => messages.join("\n").includes("restart failed"));
    expect(exits).toHaveLength(2);
    expect(exits[1]).toMatchObject({ code: null, signal: null, restartAttempt: 1, exhausted: true });
    expect(exits[1]?.error).toContain("restart failed");
    expect(readFileSync(marker, "utf8")).toBe("run");
    expect(monitors.list(true)).toEqual([]);
  } finally {
    monitors.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
