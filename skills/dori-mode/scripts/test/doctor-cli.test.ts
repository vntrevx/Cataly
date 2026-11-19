import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCommand } from "./doctor-fixture.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
test("real CLI emits JSON diagnostics and presets with isolated state and no side effects", async () => {
  const state = withState();
  try {
    // Bun owns its HOME cache; Dori must leave the separately selected state directory untouched.
    const stateDir = join(state.dir, "state");
    mkdirSync(stateDir);
    const config = join(state.dir, "config.json");
    const agentCommand = doctorCommand(state.dir);
    writeFileSync(
      config,
      JSON.stringify({
        stateDir,
        agentCommand,
        sessionsDir: join(state.dir, "sessions"),
        leadPane: "",
        runtime: "herdr",
      }),
    );
    const before = readFileSync(config, "utf8");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          HOME: state.dir,
          PATH: process.env["PATH"],
          DORI_CONFIG: config,
          DORI_STATE_DIR: stateDir,
          DORI_LEAD_PANE: "",
          DORI_RUNTIME: "herdr",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code };
    };
    const result = await run("doctor", "--json", "--repo", "acme/app");
    expect(result.code).toBe(1);
    expect(result.err).toBe("");
    const report = JSON.parse(result.out);
    expect(report.findings).toContainEqual(expect.objectContaining({ check: "repo-identities", severity: "WARN" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ check: "runtime", severity: "WARN" }));
    const presets = await run("monitor-presets", "freshness", "--json");
    expect(presets.code).toBe(0);
    expect(JSON.parse(presets.out)).toEqual([
      {
        name: "freshness",
        argv: ["dori", "freshness", "--loop", "5"],
        filter: expect.stringContaining("BLOCKED|WARNING|SUPERVISION-ERROR"),
      },
    ]);
    const invalid = await run("monitor-presets", "unknown");
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("unknown monitor preset");
    expect((await run("doctor", "--repo", "wrong")).err).toContain("--repo must be owner/repo");
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(readdirSync(stateDir)).toEqual([]);
    writeFileSync(
      config,
      JSON.stringify({
        stateDir,
        agentCommand,
        sessionsDir: join(state.dir, "sessions"),
        doctor: { ignore: ["runtime"] },
      }),
    );
    const ignored = await run("doctor", "--json");
    expect(ignored.code).toBe(0);
    expect(JSON.parse(ignored.out).ignored).toEqual(["runtime"]);
    expect(readdirSync(stateDir)).toEqual([]);
  } finally {
    state.done();
  }
});
