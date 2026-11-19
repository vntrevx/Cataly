import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { doctorProvenance } from "../../skills/dori-mode/scripts/src/doctor-provenance.ts";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { agentIn, depsFor, fakeClock, newWorld } from "../../skills/dori-mode/scripts/test/fakes.ts";
import { type FakeOptions, type FakePi, load, useConfig } from "./fake-pi.ts";

const pane = "doctor:p1";
const initial = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const next = "01a11440-ee81-7f90-b2ed-dcc7d51a0ae0";
const exact = { provider: "subscription", id: "exact" };
const keys = ["DORI_CONFIG", "DORI_STATE_DIR", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
let previous: Array<string | undefined>;
let stateDir: string;
let pi: FakePi | undefined;

beforeEach(() => {
  previous = keys.map((key) => process.env[key]);
  stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  process.env.HERDR_PANE_ID = pane;
  delete process.env.HC_TERMINAL_ID;
  pi = undefined;
});
afterEach(async () => {
  try {
    await pi?.emit("session_shutdown");
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(dirname(stateDir), { recursive: true, force: true });
  }
});

// The extension writes the actual record. Only its event API and the process-ownership probe are test fixtures.
const observe = async (session = initial, request = "subscription/exact") => {
  const world = newWorld();
  world.panes = [{ pane_id: pane, workspace_id: "doctor", agent: "omp", agent_status: "idle", cwd: stateDir }];
  agentIn(world, pane, process.pid);
  const now = Date.now();
  const findings = await doctorProvenance(
    depsFor(world, fakeClock(now), stateDir),
    [
      {
        key: "model-lane",
        title: "Model",
        thread: "none",
        brief: "/brief",
        done: "file /done",
        openedAt: new Date(now).toISOString(),
        pane,
        session,
        model: request,
      },
    ],
    null,
  );
  return findings.find((finding) => finding.detail.startsWith('lane="model-lane"'));
};

for (const scenario of [
  {
    name: "literal colon and case-insensitive exact ID",
    selector: "Subscription/Exact:14B",
    model: { ...exact, id: "exact:14b" },
    status: "matched",
    severity: "OK",
  },
  {
    name: "different provider",
    model: { ...exact, provider: "metered" },
    catalog: [exact],
    status: "mismatch",
    severity: "WARN",
  },
  {
    name: "ambiguous case collision",
    selector: "subscription/EXACT",
    model: exact,
    catalog: [exact, { ...exact, id: "Exact" }],
    status: "unknown",
    severity: "WARN",
  },
  { name: "missing exact catalog model", model: exact, catalog: [], status: "unavailable", severity: "WARN" },
  { name: "unrequested model", model: exact, unrequested: true, status: "unrequested", severity: "INFO" },
] as const) {
  test(`doctor consumes the actual producer record: ${scenario.name}`, async () => {
    const selector = "selector" in scenario ? scenario.selector : "subscription/exact";
    pi = await load({
      session: { id: initial, entries: [] },
      flags: { "dori-role": "lane", ...("unrequested" in scenario ? {} : { "dori-launch-model": selector }) },
      model: scenario.model,
      subscription: true,
      ...("catalog" in scenario && scenario.catalog !== undefined ? { catalog: [...scenario.catalog] } : {}),
    });
    await pi.emit("session_start");
    const readback = readPaneState(stateDir, pane)?.modelReadback;
    expect(readback?.status).toBe(scenario.status);
    const finding = await observe(initial, selector);
    expect(finding?.severity).toBe(scenario.severity);
    expect(finding?.detail).toContain(`status=${scenario.status}`);
    expect(finding?.detail).toContain(`observed=${scenario.model.provider}/${scenario.model.id}`);
    expect(finding?.detail).toContain("billing is not spending authorization or quota evidence");
    expect(finding?.provenance).toContain(`native-extension session=${JSON.stringify(initial)}`);
    expect(readPaneState(stateDir, pane)?.modelReadback).toEqual(readback);
    expect(pi.userMessages).toEqual([]);
  });
}

test("an unrelated resumed session cannot attest the original lane even when it carries a lane role", async () => {
  const settings: FakeOptions = {
    session: { id: initial, entries: [] },
    flags: { "dori-role": "lane", "dori-launch-model": "subscription/exact" },
    model: exact,
  };
  pi = await load(settings);
  await pi.emit("session_start");
  expect((await observe())?.severity).toBe("OK");
  pi.session = { id: next, entries: [...pi.session.entries] };
  settings.model = { provider: "other", id: "selection" };
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  expect(readPaneState(stateDir, pane)?.modelReadback?.status).toBe("unrequested");
  const stale = await observe();
  expect(stale?.detail).toContain("status=unknown");
  expect(stale?.provenance).not.toStartWith("native-extension");
  const current = await observe(next);
  expect(current?.severity).toBe("INFO");
  expect(current?.detail).toContain("status=unrequested");
  expect(current?.detail).toContain("not native launch verification");
});

test("a lane-role /new keeps its launch lock but doctor requires the registry session to catch up", async () => {
  pi = await load({
    session: { id: initial, entries: [] },
    flags: { "dori-role": "lane", "dori-launch-model": "subscription/exact" },
    model: exact,
  });
  await pi.emit("session_start");
  pi.session = { id: next, entries: [] };
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(readPaneState(stateDir, pane)?.modelReadback?.status).toBe("matched");
  expect((await observe())?.detail).toContain("status=unknown");
  expect((await observe(next))?.severity).toBe("OK");
});
