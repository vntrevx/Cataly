import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCommand } from "./doctor-fixture.ts";
import { bootCheck } from "../src/boot.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import { doctorCheck } from "../src/doctor.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

const manifest = (command: string, filter: string): Manifest => ({
  kind: "omp",
  path: "/fixture",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: [{ name: "custom-name", argv: ["dori", command], filter, cwd: "/work" }],
  },
});

test("guard and watch diagnostics probe actual state-change events", () => {
  const guard = monitorFilterFindings([manifest("guard", "^(HOST_GUARD_|WARN)")], "owner");
  expect(guard[0]?.severity).toBe("WARN");
  expect(guard[0]?.detail).toContain("HOST_GUARD ALERT");
  expect(guard[0]?.detail).toContain("HOST_GUARD CLEAR");
  expect(guard[0]?.detail).toContain("HOST_GUARD COMPUTE_BUSY");
  const watch = monitorFilterFindings([manifest("watch", "^LANE_(WATCH|DONE)")], "owner");
  for (const event of ["LANE_CHANGED", "LANE_NOT_DONE", "LANE_CLOSED", "LANE_HELD"])
    expect(watch[0]?.detail).toContain(event);
  expect(monitorFilterFindings([manifest("watch", "^LANE_")], "owner")).toEqual([]);
});

test("old session filters stay advisory while the trusted current owner's filter warns", async () => {
  const state = withState();
  try {
    const world = newWorld();
    world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
    agentIn(world, "w1:p1");
    laneState(state.dir, "w1:p1", { role: "dori", sessionId: "owner", agentStatus: "idle" });
    const deps = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir, {
      leadPane: "w1:p1",
      agentCommand: doctorCommand(state.dir),
      sessionsDir: join(state.dir, "sessions"),
    });
    const dir = join(state.dir, "monitors");
    mkdirSync(dir);
    const data = manifest("guard", "^HOST_GUARD_").data;
    writeFileSync(join(dir, "old.json"), JSON.stringify({ ...data, sessionId: "old-owner" }));
    const historical = await doctorCheck(deps);
    expect(historical.exitCode).toBe(0);
    expect(historical.findings.filter((finding) => finding.check === "monitor-filter")).toMatchObject([
      { severity: "INFO" },
    ]);
    writeFileSync(join(dir, "owner.json"), JSON.stringify(data));
    const current = await doctorCheck(deps);
    expect(current.exitCode).toBe(1);
    expect(
      current.findings
        .filter((finding) => finding.check === "monitor-filter")
        .map((finding) => finding.severity)
        .sort(),
    ).toEqual(["INFO", "WARN"]);
  } finally {
    state.done();
  }
});

test("done journals do not imply missing adoption and boot names its ignored checks", async () => {
  const state = withState();
  try {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
      leadPane: "",
      sessionsDir: join(state.dir, "sessions"),
      doctor: { ignore: ["runtime", "lessons"] },
      agentCommand: doctorCommand(state.dir),
    });
    await deps.registry.write({
      key: "complete",
      title: "complete",
      brief: "/brief",
      thread: "none",
      done: "file /done",
      openedAt: new Date(now).toISOString(),
      reportProtocol: "jsonl-v1",
    });
    const reports = new Reports(state.dir);
    reports.report("complete", "done", "local output complete", now);
    const result = await doctorCheck(deps);
    expect(result.findings.some((finding) => ["supervision", "worklog"].includes(finding.check))).toBe(false);
    expect(result.exitCode).toBe(0);
    const boot = await bootCheck({ ...deps, reports, worklog: new Worklog(state.dir), slack: async () => null });
    expect(boot.lines).toContain(
      "DOCTOR warn=0 ignored=runtime,lessons (local advisory checks; run dori doctor for details)",
    );
  } finally {
    state.done();
  }
});
