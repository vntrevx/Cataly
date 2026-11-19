import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimNativePrune, readLeases } from "../src/release/native-cache-lease.ts";
import { inspectActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { captureRuntime, nativeCli } from "../src/update/deployment-native.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";
import { waitFor } from "./update-detection-setup.ts";
import { fixture } from "./update-setup.ts";

test("public upstream status awaits the running observation instead of serializing a Promise", async () => {
  const f = fixture();
  const config = join(f.directory, "config.json");
  f.write(f.directory, "config.json", JSON.stringify(f.config));
  const cli = join(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts");
  const proc = Bun.spawn([process.execPath, cli, "upstream", "status", "--config", config], {
    env: { PATH: process.env["PATH"], HOME: f.directory },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ target: "dori", running: { status: "unknown" }, jobs: [] });
});

const activeFixture = async () => {
  const f = await managedBashFixture();
  const runtime = await captureRuntime(f.config, nativeCli(f.config), true);
  saveActiveDeployment(f.config, { ...f.record, runtime });
  return { ...f, runtime, active: join(f.config.releaseRoot, "active.json") };
};

test.skipIf(process.platform !== "linux")(
  "running revision is read back without activation, signals or deployment-state writes",
  async () => {
    const f = await activeFixture();
    const before = readFileSync(f.active, "utf8");
    const running = await inspectActiveDeployment(f.config);
    expect(running).toMatchObject({
      status: "running",
      source: f.record.releasePath,
      sourceHash: f.record.sourceHash,
      pid: f.runtime.pid,
      sessionId: f.runtime.sessionId,
      nativeVersion: f.record.toolchain!.nativeVersion,
    });
    expect(readFileSync(f.active, "utf8")).toBe(before);
    expect(sameProcess(f.runtime)).toBe(true);
    expect(existsSync(f.effect)).toBe(false);
    expect(existsSync(f.signalPath)).toBe(false);
    f.writeState({ agentStatus: "working", approvalPending: true });
    f.writeObservation();
    expect((await inspectActiveDeployment(f.config)).status).toBe("running");
    expect(existsSync(f.effect)).toBe(false);
    expect(existsSync(f.signalPath)).toBe(false);
  },
);

test.skipIf(process.platform !== "linux")("an aborted status probe does not act on the runtime", async () => {
  const f = await activeFixture();
  const before = readFileSync(f.active, "utf8");
  const controller = new AbortController();
  controller.abort();
  expect((await inspectActiveDeployment(f.config, controller.signal)).status).toBe("unknown");
  expect(readFileSync(f.active, "utf8")).toBe(before);
  expect(sameProcess(f.runtime)).toBe(true);
  expect(existsSync(f.effect)).toBe(false);
  expect(existsSync(f.signalPath)).toBe(false);
});

test.skipIf(process.platform !== "linux")(
  "status retains cache leases and cancels a held prune without deployment effects",
  async () => {
    const f = await activeFixture();
    const identity = "e".repeat(64);
    const cache = join(f.config.home, ".cache/omp-dori");
    const bin = join(cache, `native-${process.platform}-${process.arch}-${identity}`, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const alias = join(bin, "omp");
    symlinkSync(f.config.omp, alias);
    saveActiveDeployment(f.config, {
      ...f.record,
      runtime: f.runtime,
      toolchain: { ...f.record.toolchain!, omp: alias },
    });
    const before = readFileSync(f.active, "utf8");
    expect((await inspectActiveDeployment(f.config)).status).toBe("running");
    expect(readdirSync(join(cache, "native-leases", identity))).toHaveLength(1);
    expect(readLeases(cache, false).byIdentity.size).toBe(0);
    // A real cross-process kernel lock cannot be exercised with fake timers.
    const release = claimNativePrune(f.config.home);
    const abort = new AbortController();
    const pending = inspectActiveDeployment(f.config, abort.signal);
    try {
      await waitFor(() => readLeases(cache, false).byIdentity.has(identity));
      abort.abort();
      expect((await pending).status).toBe("unknown");
      expect(readLeases(cache, false).byIdentity.size).toBe(0);
      expect(readFileSync(f.active, "utf8")).toBe(before);
      expect(sameProcess(f.runtime)).toBe(true);
      expect(existsSync(f.effect)).toBe(false);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      abort.abort();
      await pending;
      release();
    }
  },
);

for (const change of ["source", "native", "session", "receipt", "health", "expired", "owner"] as const) {
  test.skipIf(process.platform !== "linux")(`historical deployment cannot attest changed ${change}`, async () => {
    const f = await activeFixture();
    const before = readFileSync(f.active, "utf8");
    if (change === "source") writeFileSync(join(f.record.releasePath, "changed.ts"), "export const changed = true;");
    if (change === "native") writeFileSync(f.config.omp, readFileSync(f.config.omp, "utf8") + "\n// changed bytes\n");
    if (change === "session") f.writeState({ sessionId: "different-session" });
    if (change === "receipt") {
      const active = JSON.parse(before);
      active.runtime.startTicks += "-stale";
      writeFileSync(f.active, JSON.stringify(active));
    }
    if (change === "health") f.writeHealth({ ...f.health, source: f.root });
    if (change === "owner") f.writeState({ pid: process.pid });
    const clock = change === "expired" ? spyOn(Date, "now").mockReturnValue(Date.now() + 6_000) : undefined;
    try {
      const current = readFileSync(f.active, "utf8");
      const result = await inspectActiveDeployment(f.config);
      expect(result.status).toBe("unknown");
      if (change === "source")
        expect(result).toHaveProperty("reason", "running source bytes differ from the verified receipt");
      if (change === "native")
        expect(result).toHaveProperty("reason", "managed native toolchain or per-process update fence changed");
      if (change === "health")
        expect(result).toHaveProperty("reason", "current native source observation is absent, stale or different");
      if (change === "expired") expect(result).toHaveProperty("reason", "monitor writer differs from native runtime");
      expect(result).not.toHaveProperty("sourceHash");
      expect(readFileSync(f.active, "utf8")).toBe(current);
      expect(sameProcess(f.runtime)).toBe(true);
      expect(existsSync(f.effect)).toBe(false);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      clock?.mockRestore();
    }
  });
}
