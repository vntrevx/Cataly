import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { doctorCheck } from "../src/doctor.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const model = { provider: "openai-codex", id: "fixture-model" };
const readback = {
  requested: model,
  observed: model,
  status: "matched",
  billing: "subscription",
  checkedAt: new Date(now).toISOString(),
  source: "native-extension",
};

test("doctor reports native observations separately from configuration and never prints credentials", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const pane = "w1:p1";
    world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
    agentIn(world, pane);
    laneState(state.dir, pane, { role: "dori", ...{ modelReadback: readback } });
    const deps = depsFor(world, fakeClock(now), state.dir, {
      leadPane: pane,
      sessionsDir: join(state.dir, "sessions"),
      defaultModel: "configured/other-model",
    });
    const before = readFileSync(join(state.dir, "sessions", "w1%3Ap1.json"), "utf8");
    const result = await doctorCheck({ ...deps, env: { DORI_DISCORD_TOKEN: "must-not-print-secret" } });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ check: "source", detail: expect.stringContaining("nativeVersion=") }),
    );
    const models = result.findings.filter((finding) => finding.check === "model");
    expect(models).toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining("configured/other-model") }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        severity: "OK",
        detail: expect.stringContaining("observed=openai-codex/fixture-model"),
        provenance: expect.stringContaining("native-extension"),
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        check: "credentials",
        detail: expect.stringContaining("DORI_DISCORD_TOKEN=present"),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("must-not-print-secret");
    expect(JSON.stringify(result)).toContain("not spending authorization");
    expect(readFileSync(join(state.dir, "sessions", "w1%3Ap1.json"), "utf8")).toBe(before);
    expect(world.calls.every((argv) => argv[0] === "ps" || argv[0] === "herdr")).toBe(true);
  } finally {
    state.done();
  }
});

test("missing and untrusted native readbacks remain unknown, never configured-model success", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const pane = "w1:p1";
    const deps = depsFor(world, fakeClock(now), state.dir, {
      leadPane: pane,
      sessionsDir: join(state.dir, "sessions"),
    });
    const absent = await doctorCheck(deps);
    expect(absent.findings).toContainEqual(
      expect.objectContaining({ check: "model", detail: expect.stringContaining("unknown") }),
    );
    laneState(state.dir, pane, { role: "dori", ...{ modelReadback: readback } });
    const untrusted = await doctorCheck(deps);
    expect(untrusted.findings.some((finding) => finding.check === "model" && finding.severity === "OK")).toBe(false);
    expect(JSON.stringify(untrusted)).not.toContain("observed=openai-codex/fixture-model");
    expect(readdirSync(state.dir)).toEqual(["sessions"]);
  } finally {
    state.done();
  }
});

for (const status of ["mismatch", "unavailable", "unknown", "unrequested"] as const) {
  test(`native model status ${status} is reported without promoting it to matched`, async () => {
    const state = withState();
    try {
      const world = newWorld();
      const pane = "w1:p1";
      world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
      agentIn(world, pane);
      laneState(state.dir, pane, {
        role: "dori",
        ...{
          modelReadback: {
            ...readback,
            status,
            requested: status === "unrequested" ? null : model,
            observed: status === "mismatch" ? { ...model, id: "other-model" } : model,
          },
        },
      });
      const result = await doctorCheck(
        depsFor(world, fakeClock(now), state.dir, { leadPane: pane, sessionsDir: join(state.dir, "sessions") }),
      );
      expect(result.findings).toContainEqual(
        expect.objectContaining({ check: "model", detail: expect.stringContaining(`status=${status}`) }),
      );
      expect(result.findings.some((finding) => finding.check === "model" && finding.severity === "OK")).toBe(false);
    } finally {
      state.done();
    }
  });
}
