import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { exactModelIdentity } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { launchLane } from "../skills/dori-mode/scripts/src/launch.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld } from "../skills/dori-mode/scripts/test/fakes.ts";
import { recordingOmp } from "./terminal-context-setup.ts";
import { expectContext, managedTerminal } from "./terminal-managed-setup.ts";

for (const runtime of ["herdr", "hc"] as const) {
  for (const external of [false, true]) {
    test(`${runtime}: full skill launch crosses a conflicting daemon with external=${external}`, async () => {
      const f = managedTerminal(runtime);
      const custom = join(f.root, "external owner tools", "omp");
      const customUlw = join(f.root, "external owner tools", "ulw.ts");
      if (external) {
        mkdirSync(dirname(custom), { recursive: true });
        recordingOmp(custom);
        writeFileSync(
          f.config.doriConfig,
          JSON.stringify({
            runtime,
            stateDir: f.config.stateDir,
            defaultCwd: f.cwd,
            agentCommand: [custom, "--owner-option", "", "{prompt}"],
            ompUlwPath: customUlw,
          }),
        );
      }
      const config = await loadConfig(f.config.doriConfig, f.config.home);
      const native = newWorld();
      const startedAt = "2026-01-01T12:00:00.000Z";
      const model = exactModelIdentity(config.defaultModel);
      const base = depsFor(native, fakeClock(Date.parse(startedAt)), config.stateDir, {
        ...config,
        defaultCwd: f.cwd,
        laneWorkspace: "w1",
        goalMarker: "",
      });
      const deps = {
        ...base,
        run: async (argv: readonly string[]) => {
          if (argv[0] === "ps" || (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list"))
            return base.run(argv);
          const result = await f.daemon.exec(argv[0]!, argv.slice(1));
          const args = argv.slice(1).filter((arg, at) => at !== 0 || arg !== "--json");
          const starting =
            (argv[0] === "herdr" && args[1] === "run") || (argv[0] === "hc" && args[0] === "send" && args[2] === "--");
          const submitted =
            (argv[0] === "herdr" && args[1] === "send-keys" && args.includes("enter")) ||
            (argv[0] === "hc" && args[0] === "send" && args.includes("--if"));
          if (starting || submitted) {
            const id = runtime === "herdr" ? args[2]! : args[1]!;
            const status = starting ? "idle" : "working";
            if (starting) agentIn(native, id, 101);
            laneState(config.stateDir, id, {
              pid: 101,
              cwd: f.cwd,
              agentStatus: status,
              modelReadback: {
                requested: model,
                observed: model,
                status: "matched",
                billing: "unknown",
                checkedAt: startedAt,
                source: "native-extension",
              },
            });
            if (runtime === "herdr") {
              native.panes = [{ pane_id: id, workspace_id: "w1", agent: "omp", agent_status: status }];
              f.world.promptFails.set(id, "agent_not_ready");
              const pane = f.world.panes.get(id)!;
              pane.agent = "omp";
              pane.foreground = "omp";
              pane.status = status;
            } else {
              const terminal = f.world.hc.terminals.get(id)!;
              terminal.pid = 100;
              terminal.foreground = { name: "omp", argv: ["omp"], pid: 101 };
              terminal.status = { app: "omp", state: status };
            }
          }
          return { code: result.code, out: result.stdout, err: result.stderr };
        },
      };
      try {
        const result = await launchLane(deps, {
          key: "skill-transport",
          title: "transport",
          brief: f.brief,
          done: "closed fixture/repo#7",
          cwd: f.cwd,
        });
        expect(result.startup).toStartWith("STARTUP_OK");
        expect(f.daemon.captures).toHaveLength(1);
        const child = expectContext(f.daemon.captures[0]!, {
          ...f.expected,
          DORI_OMP_ULW_PATH: external ? customUlw : f.expected.DORI_OMP_ULW_PATH,
        });
        if (external) {
          expect(child.argv).toEqual([custom, `--dori-launch-model=${config.defaultModel}`, "--owner-option", ""]);
          expect(child.argv).not.toContain("--config");
          expect(config.agentCommand[0]).toBe(custom);
          expect(config.ompUlwPath).toBe(customUlw);
        } else {
          expect(child.argv).toEqual([
            f.omp,
            `--dori-launch-model=${config.defaultModel}`,
            `--config=${f.toolchain.nativeConfig}`,
            "--no-extensions",
            `--extension=${join(f.toolchain.ompUlw!.source, "extension")}`,
            "--owner-option",
            "",
            "--dori-role=lane",
            `--model=${config.defaultModel}`,
          ]);
        }
        expect(child.argv.some((arg) => arg.includes(f.brief))).toBe(false);
        const messages =
          runtime === "herdr"
            ? f.world.panes.get(result.lane.pane!)!.received
            : f.world.hc.sent.slice(1).map((sent) => sent.text);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(f.brief);
        expect(messages[0]).toContain("You are the skill-transport lane");
      } finally {
        await f.daemon.close();
      }
    });
  }
}
