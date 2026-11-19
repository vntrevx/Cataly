import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux(
  "the public lead restart command resumes the initial ordinary source installation without GitHub or a source update",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const result = await f.cli("lead", "restart", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "healthy",
        sessionId: f.runtime.sessionId,
        step: "done",
      });
      const active = readActiveDeployment(f.config.deployment)!;
      expect(active.runtime.sessionFile).toBe(f.runtime.sessionFile);
      expect(sameProcess(active.runtime)).toBe(true);
      expect(sameProcess(f.runtime)).toBe(false);
      expect(await currentSource(f.config)).toEqual(f.current);
      expect(readRestartIntent(f.config.deployment)).toBeUndefined();
      expect(existsSync(f.sourceState)).toBe(false);
      expect(existsSync(f.requests)).toBe(false);
      expect(existsSync(f.signalPath)).toBe(false);
      expect(f.readNativeRequests().filter((request) => request.kind === "key")).toHaveLength(1);
      expect(f.readNativeRequests().filter((request) => request.kind === "run")).toHaveLength(1);
    } finally {
      f.closeRequests();
    }
  },
  15_000,
);

linux(
  "a lane opened during the final native screen read prevents source stop intent and every native effect",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const cli = f.config.deployment.herdr!;
      const program = readFileSync(cli, "utf8");
      const marker = "const operation = process.argv[at + 1];";
      expect(program).toContain(marker);
      const lanes = join(f.config.deployment.stateDir, "lanes");
      const late = [
        'if (operation === "read") {',
        '  const { mkdirSync, writeFileSync } = await import("node:fs");',
        `  mkdirSync(${JSON.stringify(lanes)}, { recursive: true });`,
        `  writeFileSync(${JSON.stringify(join(lanes, "late-owner-work.json"))}, ${JSON.stringify(JSON.stringify({ key: "late-owner-work", status: "working" }))});`,
        "}",
      ].join("\n");
      writeFileSync(cli, program.replace(marker, `${marker}\n${late}`));
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 4, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "held",
        step: "stop",
        error: "open lanes: late-owner-work(working)",
      });
      const record = readSourceState(f.config).job!.deployment!;
      expect(record.stopRequestedAt).toBeUndefined();
      expect(record.nativeUiExitRequestedAt).toBeUndefined();
      expect(sameProcess(f.runtime)).toBe(true);
      expect(await currentSource(f.config)).toEqual(f.current);
      expect(f.readNativeRequests()).toEqual([]);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      f.closeRequests();
    }
  },
  15_000,
);
