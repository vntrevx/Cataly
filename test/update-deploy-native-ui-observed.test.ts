import { expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deployRelease, restartDeployment } from "../src/update/deployment.ts";
import { capturePointer, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { prepareLauncher } from "../src/update/deployment-handoff.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { nativeUiConsumerFixture } from "./update-deploy-native-ui-consumer-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
for (const mode of ["release", "restart"])
  linux(
    `${mode} restores service if an already exited UI actor is followed by a failed launch`,
    async () => {
      const f = await nativeUiConsumerFixture("undelivered");
      try {
        const { config } = f;
        const manifest = sourceManifest(config.liveSource);
        const input = {
          remote: f.root,
          candidate: config.liveSource,
          commit: f.record.commit,
          tree: f.record.tree,
          sourceHash: manifest.hash,
          publicManifest: manifest,
        };
        const record: DeploymentRecord = {
          ...f.record,
          configHash: digest(JSON.stringify(config)),
          inputHash: digest(JSON.stringify(input)),
          releasePath:
            mode === "release"
              ? join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`)
              : f.record.releasePath,
          oldRuntime: f.runtime,
          oldMonitors: f.bootstrap.running!.map((entry) => ({
            ...entry.identity!,
            name: entry.name,
            argv: readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
          })),
          monitors: f.bootstrap,
          preparedAt: f.record.createdAt,
          status: "prepared",
          step: "prepare",
        };
        delete record.stopRequestedAt;
        delete record.launchRequestedAt;
        if (mode === "release") {
          cpSync(input.candidate, record.releasePath, { recursive: true });
          const launcher = prepareLauncher(config, record);
          record.pointers = [
            capturePointer(config.liveSource, record.releasePath, record.id),
            capturePointer(config.launcherPath, launcher, record.id),
          ];
          rmSync(join(config.releaseRoot, "restart-pending.json"));
          saveDeploymentJson(f.journal, record);
        } else saveRestartIntent(config, record);
        const cli = config.herdr!;
        const program = readFileSync(cli, "utf8");
        const marker = 'if (operation === "run") {';
        expect(program).toContain(marker);
        const failed = join(f.root, "first-launch-rejected");
        writeFileSync(
          cli,
          program.replace(
            marker,
            `${marker}\n  const fs = await import("node:fs");\n  if (!fs.existsSync(${JSON.stringify(failed)})) { fs.writeFileSync(${JSON.stringify(failed)}, "rejected"); process.exit(91); }`,
          ),
        );
        f.closeNativeInput();
        const deadline = Date.now() + 5000;
        while (sameProcess(f.runtime) && Date.now() < deadline) await Bun.sleep(10);
        expect(sameProcess(f.runtime)).toBe(false);
        const result =
          mode === "restart"
            ? await restartDeployment(config)
            : await deployRelease(config, input, record, (value) => saveDeploymentJson(f.journal, value));
        expect(result).toMatchObject({ status: "rolled-back", step: "done" });
        expect(result.nativeUiExitRequestedAt).toBeUndefined();
        expect(sameProcess(result.rollbackRuntime!)).toBe(true);
        expect(result.rollbackRuntime!.sessionFile).toBe(f.runtime.sessionFile);
        const events = readFileSync(f.requests, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(events.filter((event) => event.kind === "key")).toEqual([]);
        expect(events.filter((event) => event.kind === "run")).toHaveLength(1);
      } finally {
        f.closeRequests();
      }
    },
    15_000,
  );
