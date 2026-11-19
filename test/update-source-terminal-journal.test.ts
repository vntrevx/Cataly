import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readSourceState, saveSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
for (const dryRun of [true, false])
  linux(
    `terminal rollback journal is reconciled before a new source attempt (${dryRun ? "dry" : "apply"})`,
    async () => {
      const f = await sourceRolloutFixture();
      try {
        const omp = f.config.deployment.omp!;
        const program = readFileSync(omp, "utf8");
        const marker = "pid: process.pid, startedAt, updatedAt: startedAt, source,";
        expect(program).toContain(marker);
        const prefix = join(f.config.deployment.releaseRoot, "releases", f.target.commit + "-");
        writeFileSync(
          omp,
          program.replace(marker, `${marker}\n  presetLoaded: !source.startsWith(${JSON.stringify(prefix)}),`),
        );
        const first = await f.cli("update", "source", "apply", "--when", "idle");
        expect(first).toMatchObject({ code: 4, stderr: "" });
        expect(JSON.parse(first.stdout).status).toBe("rolled-back");
        const stale = readSourceState(f.config);
        const rollback = stale.job!.deployment!.rollbackRuntime!;
        const transaction = stale.job!.deployment!.id;
        delete stale.failedCommits;
        stale.job!.deployment!.status = "starting";
        stale.job!.deployment!.step = "rollback";
        saveSourceState(f.config, stale);
        const before = readFileSync(f.sourceState, "utf8");
        const nativeRequests = f.readNativeRequests().length;
        const githubRequests = f.readRequests().length;
        const result = await f.cli("update", "source", "apply", "--when", "idle", ...(dryRun ? ["--dry-run"] : []));
        expect(result).toMatchObject({ code: dryRun ? 6 : 4, stderr: "" });
        expect(JSON.parse(result.stdout).status).toBe(dryRun ? "recovery-pending" : "rolled-back");
        expect(f.readNativeRequests()).toHaveLength(nativeRequests);
        expect(f.readRequests()).toHaveLength(githubRequests);
        expect(sameProcess(rollback)).toBe(true);
        if (dryRun) expect(readFileSync(f.sourceState, "utf8")).toBe(before);
        else {
          const recovered = readSourceState(f.config);
          expect(recovered.job!.deployment!.id).toBe(transaction);
          expect(recovered.job!.deployment!.status).toBe("rolled-back");
          expect(recovered.failedCommits).toEqual([f.target.commit]);
          const blocked = await f.cli("update", "source", "apply", "--when", "idle", "--dry-run");
          expect(blocked.code).toBe(4);
          expect(blocked.stderr).toContain("--retry-failed");
          expect(f.readNativeRequests()).toHaveLength(nativeRequests);
        }
      } finally {
        f.closeRequests();
      }
    },
    30_000,
  );
