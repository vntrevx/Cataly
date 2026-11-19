import { expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deployRelease, restartDeployment } from "../src/update/deployment.ts";
import { capturePointer, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { prepareLauncher } from "../src/update/deployment-handoff.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent, saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

test.skipIf(process.platform !== "linux").each([
  ["restart", false],
  ["restart", true],
  ["release", false],
  ["release", true],
] as const)(
  "a retained %s checks new once intent before stopping a Bun-only actor (bootstrap: %s)",
  async (mode, bootstrap) => {
    const f = await managedBashFixture({ bunOnly: true });
    const manifest = sourceManifest(f.config.liveSource);
    const input = {
      remote: f.root,
      candidate: f.config.liveSource,
      commit: f.record.commit,
      tree: f.record.tree,
      sourceHash: manifest.hash,
      publicManifest: manifest,
    };
    const record: DeploymentRecord = {
      ...f.record,
      inputHash: digest(JSON.stringify(input)),
      preparedAt: f.record.createdAt,
      releasePath:
        mode === "release"
          ? join(f.config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`)
          : f.record.releasePath,
      oldRuntime: f.runtime,
      oldMonitors: f.bootstrap.running!.map((entry) => ({
        ...entry.identity!,
        name: entry.name,
        argv: readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
      })),
      monitors: f.bootstrap,
      bootstrap,
      status: "held",
      step: "stop",
    };
    delete record.stopRequestedAt;
    delete record.launchRequestedAt;
    if (mode === "release") {
      cpSync(input.candidate, record.releasePath, { recursive: true });
      const launcher = prepareLauncher(f.config, record);
      record.pointers = [
        capturePointer(f.config.liveSource, record.releasePath, record.id),
        capturePointer(f.config.launcherPath, launcher, record.id),
      ];
      rmSync(join(f.config.releaseRoot, "restart-pending.json"));
      saveDeploymentJson(f.journal, record);
    } else saveRestartIntent(f.config, record);
    writeFileSync(
      join(f.config.stateDir, "monitors", `${encodeURIComponent(f.config.sessionId)}.json`),
      JSON.stringify({
        ...f.bootstrap,
        runtime: undefined,
        running: undefined,
        version: 2,
        monitors: [
          ...f.bootstrap.monitors,
          { name: "batch", argv: [process.execPath, f.script], filter: ".", cwd: f.root, mode: "once" },
        ],
      }),
      { mode: 0o600 },
    );
    const result =
      mode === "restart"
        ? await restartDeployment(f.config)
        : await deployRelease(f.config, input, record, (value) => saveDeploymentJson(f.journal, value));
    expect({ status: result.status, live: sameProcess(f.runtime), error: result.error }).toEqual({
      status: "held",
      live: true,
      error: 'managed restart waits for once monitor "batch" to finish successfully or be explicitly stopped',
    });
    expect(result.stopRequestedAt).toBeUndefined();
    expect(result.launchRequestedAt).toBeUndefined();
    const saved =
      mode === "restart"
        ? readRestartIntent(f.config)!
        : (JSON.parse(readFileSync(f.journal, "utf8")) as DeploymentRecord);
    expect(saved.stopRequestedAt).toBeUndefined();
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    expect(existsSync(f.signalPath)).toBe(false);
    expect(existsSync(f.effect)).toBe(false);
  },
);
