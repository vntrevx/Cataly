import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
for (const operation of ["check", "dry-run", "apply"] as const)
  linux(
    `source ${operation} handles a separately journaled UI restart before idle or GitHub`,
    async () => {
      const f = await sourceRolloutFixture("undelivered");
      try {
        const restart = await f.cli("lead", "restart", "--when", "idle");
        expect(restart).toMatchObject({ code: 6, stderr: "" });
        const requested = readRestartIntent(f.config.deployment)!.nativeUiExitRequestedAt;
        expect(requested).toBeDefined();
        expect(existsSync(f.sourceState)).toBe(false);
        writeFileSync(f.unavailable, "GitHub must not strand an already requested native exit\n");
        if (operation === "apply") {
          f.closeNativeInput();
          const deadline = Date.now() + 5000;
          while (sameProcess(f.runtime) && Date.now() < deadline) await Bun.sleep(10);
          expect(sameProcess(f.runtime)).toBe(false);
        }
        const result =
          operation === "check"
            ? await f.cli("update", "source", "check")
            : await f.cli(
                "update",
                "source",
                "apply",
                "--when",
                "idle",
                ...(operation === "dry-run" ? ["--dry-run"] : []),
              );
        expect(result).toMatchObject({ code: operation === "apply" ? 0 : 6, stderr: "" });
        expect(JSON.parse(result.stdout).status).toBe(operation === "apply" ? "healthy" : "recovery-pending");
        expect(existsSync(f.requests)).toBe(false);
        expect(existsSync(f.sourceState)).toBe(false);
        expect(f.readNativeRequests().filter((request) => request.kind === "key")).toHaveLength(1);
        if (operation === "apply") {
          const active = readActiveDeployment(f.config.deployment)!;
          expect(sameProcess(active.runtime)).toBe(true);
          expect(active.runtime.sessionFile).toBe(f.runtime.sessionFile);
          expect(readRestartIntent(f.config.deployment)).toBeUndefined();
          expect(await currentSource(f.config)).toEqual(f.current);
          expect(f.readNativeRequests().filter((request) => request.kind === "run")).toHaveLength(1);
        } else {
          expect(readRestartIntent(f.config.deployment)!.nativeUiExitRequestedAt).toBe(requested);
          expect(f.readNativeRequests().filter((request) => request.kind === "run")).toEqual([]);
        }
      } finally {
        f.closeRequests();
      }
    },
    20_000,
  );
