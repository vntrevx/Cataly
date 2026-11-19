import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitors } from "../monitor.ts";
import { until } from "./fake-pi.ts";

test("an exit receipt is awaited and a late acknowledgement cannot affect a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-daemon-ack-"));
  const marker = join(root, "runs");
  const { promise: receipt, resolve: release } = Promise.withResolvers<void>();
  let calls = 0;
  const monitors = new Monitors(
    () => {},
    () => "owner",
    1,
  );
  try {
    monitors.start(
      "daemon",
      [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run'); process.exit(7)`],
      ".",
      root,
      "owner",
      {
        mode: "daemon",
        restart: { max: 1, backoffSec: 0.02 },
        onExit: () => {
          calls++;
          return receipt;
        },
      },
    );
    await until(() => calls > 0);
    await Bun.sleep(200);
    expect(readFileSync(marker, "utf8")).toBe("run");
    expect(monitors.list()).toEqual([]);
    expect(monitors.list(true)[0]).toMatchObject({ waiting: true });
    expect(monitors.stop("daemon")).toBe(true);
    const replacement = monitors.start("daemon", ["sleep", "10"], ".", root, "owner");
    release();
    await Bun.sleep(80);
    expect(monitors.list().map((monitor) => monitor.pid)).toEqual([replacement.pid]);
    expect(readFileSync(marker, "utf8")).toBe("run");
  } finally {
    release();
    monitors.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
