import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity } from "../../../../src/update/deployment-process.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import { monitorRuntimeFindings } from "../src/doctor-monitors.ts";
import type { PaneState } from "../src/lane-state.ts";
import { withState } from "./fakes.ts";

test("only a fresh matching receipt and an owned live child establish monitor liveness", async () => {
  const state = withState();
  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const startedAt = new Date().toISOString();
    const lead: PaneState = {
      paneId: "test-pane",
      role: "dori",
      sessionId: "owner",
      cwd: state.dir,
      pid: process.pid,
      startedAt,
      updatedAt: startedAt,
      goal: { status: "none" },
      approvalPending: false,
    };
    const spec = { name: "watch", argv: ["dori", "watch"], filter: "^LANE_", cwd: state.dir };
    const manifest: Manifest = {
      kind: "omp",
      path: "/unused",
      data: { version: 1, sessionId: "owner", monitors: [spec] },
    };
    const identity = processIdentity(child.pid);
    expect(identity).toBeDefined();
    mkdirSync(join(state.dir, "runtime"));
    const health = {
      version: 1,
      paneId: lead.paneId,
      role: "dori",
      sessionId: "owner",
      pid: process.pid,
      startedAt,
      updatedAt: startedAt,
      presetLoaded: true,
      monitors: [{ ...spec, pid: child.pid, startTicks: identity!.startTicks }],
    };
    const path = join(state.dir, "runtime", "test-pane.json");
    const check = () => monitorRuntimeFindings(state.dir, [manifest], lead, Date.now());
    const save = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    save(health);
    expect(check()).toEqual([{ check: "monitor-runtime", severity: "OK", detail: '"watch" live with recorded spec' }]);
    save({ ...health, monitors: [] });
    expect(check()[0]?.severity).toBe("WARN");
    expect(check()[0]?.detail).toContain("no matching live child");
    save({ ...health, monitors: [{ ...health.monitors[0], startTicks: "wrong-incarnation" }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({ ...health, monitors: [{ ...health.monitors[0], cwd: "/different" }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({ ...health, monitors: [{ ...health.monitors[0], pid: process.pid }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({
      ...health,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(check()[0]?.detail).toContain("liveness unverified");
    save({ ...health, pid: child.pid });
    expect(check()[0]?.detail).toContain("liveness unverified");
    save(health);
    expect(monitorRuntimeFindings(state.dir, [manifest], null, Date.now())[0]?.severity).toBe("INFO");
    expect(
      monitorRuntimeFindings(state.dir, [manifest], { ...lead, sessionId: "another-session" }, Date.now())[0]?.severity,
    ).toBe("INFO");
    const multiple = { ...manifest, data: { ...manifest.data, monitors: [{ ...spec, name: "broken" }, spec] } };
    save({ ...health, monitors: [{ ...health.monitors[0], name: "broken", filter: "[" }, health.monitors[0]] });
    const independent = monitorRuntimeFindings(state.dir, [multiple], lead, Date.now());
    expect(independent.map((finding) => finding.severity)).toEqual(["WARN", "OK"]);
    expect(independent[0]?.detail).toContain("invalid or unreadable process receipt");
    save(health);
    child.kill();
    await child.exited;
    expect(check()[0]?.severity).toBe("WARN");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    state.done();
  }
});
