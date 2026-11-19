import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isModelSnapshot, paneStatePath, readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { identityOf, type ModelSwitchRequest } from "../../skills/dori-mode/scripts/src/model-switch-state.ts";
import { Registry } from "../../skills/dori-mode/scripts/src/registry.ts";
import { createModelProfileFile } from "../../skills/dori-mode/scripts/src/model-profile.ts";
import { requiredSourceRequest } from "../../test/fixtures/omp-native-host/required-source.ts";
import { useConfig } from "./fake-pi.ts";

test("real native idle command selects once, preserves defaults and dispatches through its new snapshot", async () => {
  const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
  const previous = keys.map((key) => process.env[key]);
  const stateDir = useConfig("");
  const home = dirname(stateDir);
  process.env.HOME = home;
  process.env.HERDR_PANE_ID = "native-model:p1";
  delete process.env.DORI_OMP_ULW_PATH;
  delete process.env.HC_TERMINAL_ID;
  const cwd = join(home, "project");
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  const globalFile = join(agentDir, "config.yml");
  const selected = "openai/required-source-local";
  const alternateModelId = "required-source-next";
  writeFileSync(globalFile, JSON.stringify({ modelRoles: { default: selected }, defaultThinkingLevel: "low" }));
  const globalBefore = readFileSync(globalFile, "utf8");
  const nonce = randomUUID();
  try {
    const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, "lane", "session", selected, {
      file: createModelProfileFile(stateDir),
      persistentSession: true,
      alternateModelId,
      async beforeRequest(session) {
        const state = readPaneState(stateDir, "native-model:p1");
        if (!state?.modelSnapshot) throw new Error("real native launch snapshot missing");
        const identity = identityOf(state);
        if (!identity) throw new Error("real native session file missing");
        const request: ModelSwitchRequest = {
          version: 1,
          nonce,
          requested: `openai/${alternateModelId}`,
          createdAt: new Date().toISOString(),
          head: { ...identity, paneId: "head:p1", sessionId: "head", sessionFile: join(home, "head.jsonl") },
          target: identity,
          priorSnapshotId: state.modelSnapshot.id,
        };
        await new Registry(stateDir).write({
          key: "lane",
          title: "native switch",
          brief: join(home, "brief.md"),
          done: "fixture",
          thread: "none",
          pane: state.paneId,
          openedAt: state.startedAt,
          session: state.sessionId,
          sessionFile: state.sessionFile,
          modelProfileFile: state.modelProfileFile,
          modelSnapshot: state.modelSnapshot,
          modelSwitchRequest: request,
        });
        const runner = session.extensionRunner;
        const command = runner?.getCommand("dori-model-apply");
        if (!runner || !command) throw new Error("real native command registration missing");
        const run = () => runner.runScoped(() => command.handler(`lane ${nonce}`, runner.createCommandContext()));
        await run();
        expect(readPaneState(stateDir, "native-model:p1")?.modelSwitch).toEqual({ nonce, status: "changed" });
        expect(session.agent.state.model?.id).toBe(alternateModelId);
        expect(readPaneState(stateDir, "native-model:p1")?.modelReadback).toMatchObject({
          status: "matched",
          requested: { provider: "openai", id: alternateModelId },
          observed: { provider: "openai", id: alternateModelId },
        });
        await run();
        const snapshots = session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "omp-dori:model-snapshot");
        expect(snapshots).toHaveLength(2);
        expect(readPaneState(stateDir, "native-model:p1")?.goal.status).toBe("none");
        await session.settings.flush();
        expect(readFileSync(globalFile, "utf8")).toBe(globalBefore);
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.requests).toBe(1);
    expect(result.modelSnapshot).toMatchObject({
      id: nonce,
      model: { provider: "openai", id: alternateModelId },
      modelRoles: { default: selected },
      provenance: { kind: "idle-switch", requested: `openai/${alternateModelId}` },
    });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(home, { recursive: true, force: true });
  }
});

test("real native refused idle switch keeps the unchanged pinned lane running", async () => {
  const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
  const previous = keys.map((key) => process.env[key]);
  const stateDir = useConfig("");
  const home = dirname(stateDir);
  process.env.HOME = home;
  process.env.HERDR_PANE_ID = "native-model:p2";
  delete process.env.DORI_OMP_ULW_PATH;
  delete process.env.HC_TERMINAL_ID;
  const cwd = join(home, "project");
  mkdirSync(join(cwd, "agent"), { recursive: true });
  const selected = "openai/required-source-local";
  writeFileSync(
    join(cwd, "agent", "config.yml"),
    JSON.stringify({ modelRoles: { default: selected }, defaultThinkingLevel: "low" }),
  );
  const nonce = randomUUID();
  try {
    const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, "lane", "session", selected, {
      file: createModelProfileFile(stateDir),
      persistentSession: true,
      async beforeRequest(session) {
        const state = readPaneState(stateDir, "native-model:p2");
        const identity = state && identityOf(state);
        if (!state?.modelSnapshot || !identity) throw new Error("real native launch snapshot missing");
        await new Registry(stateDir).write({
          key: "lane",
          title: "native refused switch",
          brief: join(home, "brief.md"),
          done: "fixture",
          thread: "none",
          pane: state.paneId,
          openedAt: state.startedAt,
          session: state.sessionId,
          sessionFile: state.sessionFile,
          modelProfileFile: state.modelProfileFile,
          modelSnapshot: state.modelSnapshot,
          modelSwitchRequest: {
            version: 1,
            nonce,
            requested: "openai/not-in-native-catalog",
            createdAt: new Date().toISOString(),
            head: { ...identity, paneId: "head:p2", sessionId: "head", sessionFile: join(home, "head.jsonl") },
            target: identity,
            priorSnapshotId: state.modelSnapshot.id,
          },
        });
        const runner = session.extensionRunner;
        const command = runner?.getCommand("dori-model-apply");
        if (!runner || !command) throw new Error("real native command registration missing");
        await runner.runScoped(() => command.handler(`lane ${nonce}`, runner.createCommandContext()));
        const after = readPaneState(stateDir, "native-model:p2");
        expect(after?.modelSwitch).toMatchObject({ nonce, status: "failed" });
        expect(after?.modelSnapshotError).toBeUndefined();
        expect(after?.modelSnapshot).toEqual(state.modelSnapshot);
        expect(session.agent.state.model?.id).toBe("required-source-local");
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.requests).toBe(1);
    expect(result.modelSnapshot).toMatchObject({ provenance: { kind: "launch", requested: selected } });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(home, { recursive: true, force: true });
  }
});

for (const boundary of ["session", "provider"] as const) {
  for (const initial of ["low", "auto"] as const) {
    test(`real native ${boundary}: changed thinking ${initial} to high is held before dispatch`, async () => {
      const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
      const previous = keys.map((key) => process.env[key]);
      const stateDir = useConfig("");
      const home = dirname(stateDir);
      process.env.HOME = home;
      delete process.env.DORI_OMP_ULW_PATH;
      delete process.env.HERDR_PANE_ID;
      delete process.env.HC_TERMINAL_ID;
      const cwd = join(home, "project");
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir, { recursive: true });
      const globalFile = join(agentDir, "config.yml");
      const selected = "openai/required-source-local";
      writeFileSync(globalFile, JSON.stringify({ modelRoles: { default: selected }, defaultThinkingLevel: initial }));
      const globalBefore = readFileSync(globalFile, "utf8");
      try {
        const result = await requiredSourceRequest(
          join(import.meta.dir, "../index.ts"),
          cwd,
          "lane",
          boundary,
          selected,
          {
            file: createModelProfileFile(stateDir),
            reasoning: true,
            async beforeRequest(session) {
              expect(session.thinkingLevel?.toString()).toBe(initial === "auto" ? "high" : "low");
              expect(session.configuredThinkingLevel()?.toString()).toBe(initial);
              const high = session.getAvailableEffortSelectors().find((level) => level === "high");
              if (high === undefined) throw new Error("native reasoning fixture has no high effort");
              session.setThinkingLevel(high);
              expect(session.thinkingLevel?.toString()).toBe("high");
              expect(session.configuredThinkingLevel()?.toString()).toBe("high");
              expect(readFileSync(globalFile, "utf8")).toBe(globalBefore);
            },
          },
        );
        expect(result.modelSnapshot).toMatchObject({
          configuredThinkingLevel: initial,
          thinkingLevel: initial === "auto" ? "high" : "low",
          defaultThinkingLevel: initial,
        });
        expect(result.requests).toBe(0);
        expect(result.errors.some((error) => error.error.includes("MODEL_SNAPSHOT_HOLD"))).toBe(true);
      } finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

for (const boundary of ["session", "provider"] as const) {
  for (const [extraRole, publicationFails] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const) {
    test(`real native ${boundary}: ${publicationFails ? "pane publication failure still stops dispatch" : extraRole ? "unexpected role holds before dispatch" : "edited defaults do not retarget a pinned lane"}`, async () => {
      const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
      const previous = keys.map((key) => process.env[key]);
      const stateDir = useConfig("");
      const home = dirname(stateDir);
      process.env.HOME = home;
      delete process.env.DORI_OMP_ULW_PATH;
      if (publicationFails) process.env.HERDR_PANE_ID = "native-publish:p1";
      else delete process.env.HERDR_PANE_ID;
      delete process.env.HC_TERMINAL_ID;
      const cwd = join(home, "project");
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir, { recursive: true });
      const globalFile = join(agentDir, "config.yml");
      const selected = "openai/required-source-local";
      writeFileSync(globalFile, JSON.stringify({ modelRoles: { default: selected }, defaultThinkingLevel: "low" }));
      try {
        const result = await requiredSourceRequest(
          join(import.meta.dir, "../index.ts"),
          cwd,
          "lane",
          boundary,
          selected,
          {
            file: createModelProfileFile(stateDir),
            async beforeRequest(session) {
              writeFileSync(
                globalFile,
                JSON.stringify({
                  modelRoles: {
                    default: "openai/not-selected",
                    ...(extraRole ? { scout: "openai/not-selected" } : {}),
                  },
                  defaultThinkingLevel: "high",
                }),
              );
              await session.settings.reloadFromDisk();
              const runner = session.extensionRunner;
              if (!runner) throw new Error("native extension runner missing");
              const spawn = await runner.emitBeforeSubagentSpawn({
                type: "before_subagent_spawn",
                agent: "task",
                invocationKind: "task",
                patterns: [selected],
              });
              if (extraRole)
                expect(spawn).toMatchObject({ block: true, reason: expect.stringContaining("unexpected role scout") });
              else expect(spawn).toBeUndefined();
              if (publicationFails) {
                const path = paneStatePath(stateDir, "native-publish:p1");
                renameSync(path, `${path}.saved`);
                mkdirSync(path);
              }
            },
          },
        );
        expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
        expect(isModelSnapshot(result.modelSnapshot)).toBe(true);
        expect(result.modelSnapshot).toMatchObject({
          model: { provider: "openai", id: "required-source-local" },
          modelRoles: { default: selected },
          defaultThinkingLevel: "low",
          provenance: { kind: "launch", requested: selected, modelRoles: { default: "global" } },
        });
        expect(result.requests).toBe(extraRole ? 0 : 1);
        if (extraRole)
          expect(
            result.errors.some((error) =>
              publicationFails ? /directory/i.test(error.error) : error.error.includes("MODEL_SNAPSHOT_HOLD"),
            ),
          ).toBe(true);
      } finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
