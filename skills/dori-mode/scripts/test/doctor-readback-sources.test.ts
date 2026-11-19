import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCheck } from "../src/doctor.ts";
import { type ModelReadback, paneStatePath, readPaneState } from "../src/lane-state.ts";
import { unavailableLaunchModel } from "../src/launch-model.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const model = { provider: "openai-codex", id: "fixture-model" };
const preflight = {
  requested: model,
  observed: null,
  status: "unavailable",
  billing: "unknown",
  checkedAt: new Date(now - 60_000).toISOString(),
  source: "launch-preflight",
  reason: "Opaque runner cannot be inspected before the first prompt",
} satisfies ModelReadback;
const native = {
  ...preflight,
  observed: model,
  status: "matched",
  billing: "subscription",
  checkedAt: new Date(now).toISOString(),
  source: "native-extension",
  reason: "Exact native catalog identity observed",
} satisfies ModelReadback;

const inspect = async (
  receipt: unknown,
  live: boolean,
  options: { nativeReadback?: unknown; request?: string } = {},
) => {
  const state = withState();
  try {
    const world = newWorld();
    const pane = "w1:p2";
    if (live) {
      world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
      agentIn(world, pane);
      laneState(state.dir, pane, { role: "lane" });
      await Bun.write(
        paneStatePath(state.dir, pane),
        JSON.stringify({
          ...readPaneState(state.dir, pane),
          modelReadback: "nativeReadback" in options ? options.nativeReadback : native,
        }),
      );
    }
    const deps = depsFor(world, fakeClock(now), state.dir, { leadPane: "", sessionsDir: join(state.dir, "sessions") });
    await deps.registry.write({
      key: "fixture-lane",
      title: "Fixture",
      thread: "none",
      brief: "/brief",
      done: "file /done",
      openedAt: new Date(now).toISOString(),
      pane,
      session: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf",
      model: options.request ?? "openai-codex/fixture-model",
    });
    const path = deps.registry.path("fixture-lane");
    await Bun.write(path, JSON.stringify({ ...(await deps.registry.read("fixture-lane")), modelReadback: receipt }));
    const before = readFileSync(path, "utf8");
    const result = await doctorCheck(deps);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(world.calls.every((argv) => argv[0] === "ps" || argv[0] === "herdr")).toBe(true);
    return result.findings;
  } finally {
    state.done();
  }
};

for (const live of [false, true]) {
  test(`preflight remains a historical receipt with live native observation=${live}`, async () => {
    const findings = await inspect(preflight, live);
    const receipt = findings.find((entry) => entry.provenance?.startsWith("launch-preflight"));
    expect(receipt?.severity).toBe("INFO");
    expect(receipt?.detail).toContain("status=unavailable");
    expect(receipt?.detail).toContain("observed=unknown");
    expect(receipt?.detail).toContain("billing=unknown");
    expect(receipt?.detail).toContain(preflight.reason);
    expect(receipt?.provenance).toContain(preflight.checkedAt);
    expect(receipt?.provenance).toContain("historical");
    const observation = findings.find((entry) => entry.detail.startsWith('lane="fixture-lane"') && entry !== receipt);
    expect(observation?.severity).toBe(live ? "OK" : "INFO");
    expect(observation?.detail).toContain(live ? "status=matched" : "status=unknown");
    if (live) expect(observation?.detail).toContain(native.reason);
    else expect(observation?.provenance).not.toStartWith("native-extension");
  });
}

test("opaque unrequested native observation remains visible beside the launch choice", async () => {
  const findings = await inspect(preflight, true, {
    nativeReadback: { ...native, requested: null, status: "unrequested", observed: { ...model, id: "actual-model" } },
  });
  const finding = findings.find((entry) => entry.provenance?.startsWith("native-extension"));
  expect(finding?.severity).toBe("INFO");
  expect(finding?.detail).toContain("status=unrequested");
  expect(finding?.detail).toContain("observed=openai-codex/actual-model");
  expect(finding?.detail).toContain('recorded request="openai-codex/fixture-model"');
  expect(finding?.detail).toContain("not native launch verification");
  expect(findings.some((entry) => entry.check === "model" && entry.severity === "OK")).toBe(false);
});

test("opaque unknown readback reports missing observation, not a different request", async () => {
  const findings = await inspect(preflight, true, {
    nativeReadback: {
      ...native,
      requested: null,
      observed: null,
      status: "unknown",
      reason: "Native model is unavailable",
    },
  });
  const finding = findings.find((entry) => entry.provenance?.startsWith("native-extension"));
  expect(finding?.severity).toBe("WARN");
  expect(finding?.detail).toContain("status=unknown");
  expect(finding?.detail).toContain("Native model is unavailable");
  expect(finding?.detail).not.toContain("recorded request differs");
});

test("raw exact catalog collisions remain a native mismatch", async () => {
  const findings = await inspect(preflight, true, {
    nativeReadback: { ...native, status: "mismatch", observed: { ...model, id: "FIXTURE-MODEL" } },
  });
  const finding = findings.find((entry) => entry.provenance?.startsWith("native-extension"));
  expect(finding?.severity).toBe("WARN");
  expect(finding?.detail).toContain("status=mismatch");
  expect(finding?.detail).toContain("observed=openai-codex/FIXTURE-MODEL");
});

test("opaque receipt without the selected exact identity stays unknown", async () => {
  const findings = await inspect({ ...preflight, requested: null }, false);
  const finding = findings.find((entry) => entry.provenance?.includes("registry receipt"));
  expect(finding?.detail).toContain("status=unknown");
  expect(finding?.provenance).not.toStartWith("launch-preflight");
});

for (const request of ["fixture-model", "openai-codex/*"]) {
  test(`producer alias receipt preserves unavailability and its reason: ${request}`, async () => {
    const receipt = unavailableLaunchModel(
      ["sh", "-c", 'exec omp "$@"', "agent", "--model", "{model}", "{prompt}"],
      request,
      preflight.checkedAt,
    );
    expect(receipt?.requested).toBeNull();
    expect(receipt?.status).toBe("unavailable");
    expect(receipt?.source).toBe("launch-preflight");
    expect(receipt?.reason).toStartWith("Opaque agentCommand:");
    const findings = await inspect(receipt, false, { request });
    const finding = findings.find((entry) => entry.provenance?.startsWith("launch-preflight"));
    expect(finding, JSON.stringify(findings)).toBeDefined();
    expect(finding?.severity).toBe("INFO");
    expect(finding?.detail).toContain("status=unavailable requested=none observed=unknown");
    expect(finding?.detail).toContain(JSON.stringify(receipt?.reason));
    expect(finding?.detail).toContain(`recorded request=${JSON.stringify(request)}`);
    expect(finding?.detail).toContain("request comparison=unknown");
    expect(finding?.provenance).toContain("historical");
    expect(findings.some((entry) => entry.check === "model" && entry.severity === "OK")).toBe(false);
  });
}

test("a missing requested field is not a nullable alias receipt", async () => {
  const findings = await inspect({ ...preflight, requested: undefined }, false, { request: "fixture-model" });
  const finding = findings.find((entry) => entry.provenance?.includes("registry receipt"));
  expect(finding?.detail).toContain("status=unknown");
  expect(finding?.provenance).not.toStartWith("launch-preflight");
});

const invalid = [
  null,
  true,
  { ...preflight, status: "matched" },
  { ...preflight, observed: model },
  { ...preflight, billing: "subscription" },
  { ...preflight, reason: undefined },
  { ...preflight, reason: "" },
  { ...preflight, checkedAt: "not-a-date" },
  { ...preflight, source: "native-extension" },
  { ...preflight, requested: { ...model, id: "other-model" } },
];
for (const [index, receipt] of invalid.entries()) {
  test(`contradictory registry receipt stays unknown ${index}`, async () => {
    const findings = await inspect(receipt, false);
    const finding = findings.find((entry) => entry.provenance?.includes("registry receipt"));
    expect(finding?.severity).toBe("INFO");
    expect(finding?.detail).toContain("status=unknown");
    expect(findings.some((entry) => entry.check === "model" && entry.severity === "OK")).toBe(false);
  });
}
