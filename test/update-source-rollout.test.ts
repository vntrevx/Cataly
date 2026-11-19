import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState, saveSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux(
  "actual source CLI dry-run and full apply preserve the session and verify replacement health",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const idle = await f.cli("idle-check");
      expect(idle).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(idle.stdout)).toMatchObject({ status: "idle", receivers: 1 });
      for (const args of [
        ["update", "source", "apply"],
        ["lead", "restart"],
      ]) {
        const dry = await f.cli(...args, "--when", "idle", "--dry-run");
        expect(dry).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(dry.stdout)).toMatchObject({ status: "ready", dryRun: true });
        expect(existsSync(f.sourceState)).toBe(false);
        expect(existsSync(join(f.config.deployment.releaseRoot, "source-candidates"))).toBe(false);
        expect(sameProcess(f.runtime)).toBe(true);
        expect(f.readNativeRequests()).toEqual([]);
      }
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "healthy",
        commit: f.target.commit,
        sessionId: f.config.deployment.sessionId,
        step: "done",
      });
      const record = readSourceState(f.config).job!.deployment!;
      expect(record.runtime!.sessionFile).toBe(f.runtime.sessionFile);
      expect(record.runtime!.sessionId).toBe(f.runtime.sessionId);
      expect(sameProcess(record.runtime!)).toBe(true);
      expect(sameProcess(f.runtime)).toBe(false);
      expect(realpathSync(f.config.deployment.liveSource)).toBe(record.releasePath);
      expect((await currentSource(f.config)).commit).toBe(f.target.commit);
      expect(readActiveDeployment(f.config.deployment)!.runtime.pid).toBe(record.runtime!.pid);
      expect(f.readNativeRequests().filter((request) => request.kind === "key")).toEqual([
        { kind: "key", line: "ctrl+d" },
      ]);
      expect(f.readNativeRequests().filter((request) => request.kind === "run")).toHaveLength(1);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);

linux(
  "effectful source recovery trusts the managed journal over a stale outer receipt and unavailable fresh CI",
  async () => {
    const f = await sourceRolloutFixture("undelivered");
    try {
      const first = await f.cli("update", "source", "apply", "--when", "idle");
      expect(first).toMatchObject({ code: 6, stderr: "" });
      expect(JSON.parse(first.stdout)).toMatchObject({ status: "recovery-pending", step: "stop" });
      expect(sameProcess(f.runtime)).toBe(true);
      const state = readSourceState(f.config);
      const record = state.job!.deployment!;
      const requestedAt = record.nativeUiExitRequestedAt;
      expect(requestedAt).toBeDefined();
      const authoritative = JSON.parse(readFileSync(join(record.directory, "deployment.json"), "utf8"));
      expect(authoritative.nativeUiExitRequestedAt).toBe(requestedAt);
      delete record.stopRequestedAt;
      delete record.nativeUiExitRequestedAt;
      delete record.error;
      delete record.retryableHold;
      record.status = "prepared";
      record.step = "prepare";
      saveSourceState(f.config, state);
      writeFileSync(f.unavailable, "GitHub must not be queried during effectful recovery\n");
      const calls = f.readRequests().length;
      const check = await f.cli("update", "source", "check");
      expect(check.code).toBe(6);
      const restart = await f.cli("lead", "restart", "--when", "idle", "--dry-run");
      expect(restart.code).toBe(4);
      expect(restart.stderr).toContain("finish source update recovery");
      // The already-requested normal exit completes independently; its receiver lease then disappears.
      f.closeNativeInput();
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).status).toBe("healthy");
      const recovered = readSourceState(f.config).job!.deployment!;
      expect(recovered.nativeUiExitRequestedAt).toBe(requestedAt);
      expect(recovered.runtime!.sessionFile).toBe(f.runtime.sessionFile);
      expect(f.readRequests()).toHaveLength(calls);
      expect(f.readNativeRequests().filter((request) => request.kind === "key")).toHaveLength(1);
      expect(f.readNativeRequests().filter((request) => request.kind === "run")).toHaveLength(1);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);

linux(
  "failed source health rolls back and blocks the same target until an explicit retry",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const flag = join(f.root, "reject-new-health");
      writeFileSync(flag, "reject candidate health\n");
      const targetPath = join(
        f.config.deployment.releaseRoot,
        "releases",
        `${f.target.commit}-${sourceManifest(f.remote).hash.slice(0, 16)}`,
      );
      const omp = f.config.deployment.omp!;
      const program = readFileSync(omp, "utf8");
      const health = "pid: process.pid, startedAt, updatedAt: startedAt, source,";
      expect(program).toContain(health);
      writeFileSync(
        omp,
        program.replace(
          health,
          `${health}\n  presetLoaded: source !== ${JSON.stringify(targetPath)} || !(await Bun.file(${JSON.stringify(flag)}).exists()),`,
        ),
      );
      const failed = await f.cli("update", "source", "apply", "--when", "idle");
      expect(failed).toMatchObject({ code: 4, stderr: "" });
      expect(JSON.parse(failed.stdout).status).toBe("rolled-back");
      const state = readSourceState(f.config);
      expect(state.failedCommits).toEqual([f.target.commit]);
      expect(state.job!.deployment!.rollbackRuntime!.sessionId).toBe(f.runtime.sessionId);
      expect((await currentSource(f.config)).commit).toBe(f.current.commit);
      const requests = f.readNativeRequests().length;
      for (const suffix of [[], ["--dry-run"]]) {
        const held = await f.cli("update", "source", "apply", "--when", "idle", ...suffix);
        expect(held.code).toBe(4);
        expect(held.stderr).toContain("--retry-failed");
        expect(f.readNativeRequests()).toHaveLength(requests);
      }
      rmSync(flag);
      const retried = await f.cli("update", "source", "apply", "--when", "idle", "--retry-failed");
      expect({ ...retried, nativeEvents: readFileSync(join(f.root, "native-ui-events"), "utf8") }).toMatchObject({
        code: 0,
        stderr: "",
      });
      expect(JSON.parse(retried.stdout).status).toBe("healthy");
      expect(readSourceState(f.config).failedCommits).toBeUndefined();
      expect((await currentSource(f.config)).commit).toBe(f.target.commit);
    } finally {
      f.closeRequests();
    }
  },
  30_000,
);
