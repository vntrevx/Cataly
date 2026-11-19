import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent, saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState, saveSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
function openLaneAtScreen(f: Awaited<ReturnType<typeof sourceRolloutFixture>>) {
  const cli = f.config.deployment.herdr!;
  const program = readFileSync(cli, "utf8");
  const marker = "const operation = process.argv[at + 1];";
  expect(program).toContain(marker);
  const lanes = join(f.config.deployment.stateDir, "lanes");
  const lane = join(lanes, "late-owner-work.json");
  const late = [
    'if (operation === "read") {',
    '  const { mkdirSync, writeFileSync } = await import("node:fs");',
    `  mkdirSync(${JSON.stringify(lanes)}, { recursive: true });`,
    `  writeFileSync(${JSON.stringify(lane)}, ${JSON.stringify(JSON.stringify({ key: "late-owner-work", status: "working" }))});`,
    "}",
  ].join("\n");
  writeFileSync(cli, program.replace(marker, `${marker}\n${late}`));
  return lane;
}

linux(
  "source apply rechecks its policy while recovering a pending separate restart",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const lane = openLaneAtScreen(f);
      const held = await f.cli("lead", "restart", "--when", "idle");
      expect(held.code).toBe(4);
      expect(readRestartIntent(f.config.deployment)?.stopRequestedAt).toBeUndefined();
      unlinkSync(lane);
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result.code).toBe(4);
      expect(readRestartIntent(f.config.deployment)?.error).toContain("open lanes");
      expect(f.readNativeRequests()).toEqual([]);
      expect(sameProcess(f.runtime)).toBe(true);
      expect(await currentSource(f.config)).toEqual(f.current);
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);

for (const operation of ["apply", "restart"] as const)
  linux(
    `${operation} rechecks admission after stop intent but before the first UI request`,
    async () => {
      const f = await sourceRolloutFixture();
      try {
        openLaneAtScreen(f);
        const args =
          operation === "apply"
            ? ["update", "source", "apply", "--when", "idle"]
            : ["lead", "restart", "--when", "idle"];
        expect((await f.cli(...args)).code).toBe(4);
        const state = readSourceState(f.config);
        const record = operation === "apply" ? state.job!.deployment! : readRestartIntent(f.config.deployment)!;
        expect(record.nativeUiExitRequestedAt).toBeUndefined();
        record.stopRequestedAt = new Date().toISOString();
        if (operation === "apply") {
          saveDeploymentJson(join(record.directory, "deployment.json"), record);
          saveSourceState(f.config, state);
        } else saveRestartIntent(f.config.deployment, record);
        const resumed = await f.cli(...args);
        expect(resumed.code).toBe(4);
        if (operation === "apply") {
          expect(resumed.stdout).toBe("");
          expect(resumed.stderr).toContain("SOURCE_UPDATE_HELD open lanes: late-owner-work(working)");
        } else
          expect(JSON.parse(resumed.stdout)).toMatchObject({
            status: "held",
            error: "open lanes: late-owner-work(working)",
          });
        const latest =
          operation === "apply" ? readSourceState(f.config).job!.deployment! : readRestartIntent(f.config.deployment)!;
        expect(latest.nativeUiExitRequestedAt).toBeUndefined();
        expect(readSourceState(f.config).failedCommits).toBeUndefined();
        expect(sameProcess(f.runtime)).toBe(true);
        expect(await currentSource(f.config)).toEqual(f.current);
        expect(f.readNativeRequests()).toEqual([]);
        expect(existsSync(f.signalPath)).toBe(false);
      } finally {
        f.closeRequests();
      }
    },
    20_000,
  );

linux(
  "an expired pre-UI stop intent does not prevent a fresh safe source attempt",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const cli = f.config.deployment.herdr!;
      const original = readFileSync(cli, "utf8");
      const lane = openLaneAtScreen(f);
      expect((await f.cli("update", "source", "apply", "--when", "idle")).code).toBe(4);
      const state = readSourceState(f.config);
      const record = state.job!.deployment!;
      record.stopRequestedAt = new Date(Date.now() - 7_200_000).toISOString();
      record.retryDeadlineAt = new Date(Date.now() - 3_600_000).toISOString();
      saveDeploymentJson(join(record.directory, "deployment.json"), record);
      saveSourceState(f.config, state);
      unlinkSync(lane);
      writeFileSync(cli, original);
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const fresh = readSourceState(f.config).job!.deployment!;
      expect(fresh.id).not.toBe(record.id);
      expect(fresh.status).toBe("healthy");
      expect(
        JSON.parse(readFileSync(join(record.directory, "deployment.json"), "utf8")).nativeUiExitRequestedAt,
      ).toBeUndefined();
      expect(f.readNativeRequests().filter((request) => request.kind === "key")).toHaveLength(1);
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);
