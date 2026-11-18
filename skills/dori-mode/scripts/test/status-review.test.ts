import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMonitorManifests } from "../src/boot-monitors.ts";
import { Reports } from "../src/reports.ts";
import { laneStatus } from "../src/status.ts";
import { renderBoard, renderStatus } from "../src/status-render.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T13:00:00Z");
const lane = {
  key: "healthy",
  title: "Healthy",
  thread: "discord:40",
  openedAt: "2026-01-01T12:00:00Z",
  brief: "brief",
  done: "file proof",
};
let state: ReturnType<typeof withState>;
const deps = () => depsFor(newWorld(), fakeClock(now), state.dir, { sessionsDir: join(state.dir, "sessions") });
beforeEach(async () => {
  state = withState();
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test.each([
  ["/home/Alice Smith", "/home/Alice Smith/PRIVATE_SUFFIX.txt"],
  ["/Users/Alice Smith", "/Users/Alice Smith/PRIVATE_SUFFIX.txt"],
  [String.raw`C:\Users\Alice Smith`, String.raw`C:\Users\Alice Smith\PRIVATE_SUFFIX.txt`],
  ["/home/test", "/srv/Project Name/PRIVATE_SUFFIX.txt"],
  ["/home/test", String.raw`\\server\Shared Folder\PRIVATE_SUFFIX.txt`],
  ["/home/test", "~/Folder Name/PRIVATE_SUFFIX.txt"],
  ["/home/test", "Log:[/tmp/Folder Name/PRIVATE_SUFFIX.txt]"],
  ["/home/test", "//server/Shared Folder/PRIVATE_SUFFIX.txt"],
  ["/home/test", "/tmp/https://example.test/PRIVATE_SUFFIX.txt"],
  ["/home/Alice\u00a0Smith", "/home/Alice\u00a0Smith/PRIVATE_SUFFIX.txt"],
])("board hides the complete spaced path %s -> %s", async (home, path) => {
  const url = "https://example.test/home/reports/test?ref=1";
  new Reports(state.dir).report(lane.key, "milestone", `Build passed. Evidence: ${path} ${url}`, now);
  const body = renderBoard(await laneStatus(deps()), home, 1960);
  expect(body).not.toContain("PRIVATE_SUFFIX");
  expect(body).not.toContain("Smith");
  expect(body).toContain("Build passed");
  expect(body).toContain(url);
});

test.each([
  ["invalid JSON", "{broken"],
  ["null", "null"],
  ["array", "[]"],
  ["primitive", "42"],
  ["missing fields", '{"key":"damaged"}'],
  ["thread type", JSON.stringify({ ...lane, key: "damaged", thread: 7 })],
  ["title type", JSON.stringify({ ...lane, key: "damaged", title: {} })],
  ["unsafe key", JSON.stringify({ ...lane, key: "../escape" })],
  ["filename identity mismatch", JSON.stringify(lane)],
  ["note type", JSON.stringify({ ...lane, key: "damaged", lastFreshnessNote: 17 })],
  ["status enum", JSON.stringify({ ...lane, key: "damaged", status: "unknown" })],
  ["runtime enum", JSON.stringify({ ...lane, key: "damaged", sessionRef: { runtime: "invalid", id: "7" } })],
  ["timestamp type", JSON.stringify({ ...lane, key: "damaged", lastNudgeAt: "0" })],
  ["opened timestamp", JSON.stringify({ ...lane, key: "damaged", openedAt: "false" })],
  ["closed timestamp", JSON.stringify({ ...lane, key: "damaged", closedAt: "false" })],
])("status retains healthy lanes when a registry record has %s", async (_label, data) => {
  writeFileSync(join(state.dir, "lanes", "damaged.json"), data);
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes.map((item) => item.key)).toEqual([lane.key]);
  expect(snapshot.registryIncomplete).toBe(true);
  expect(snapshot.errors.some((error) => error.includes("registry"))).toBe(true);
  expect(renderBoard(snapshot, "/home/test", 1960)).toContain("incomplete");
});

test("a specifically requested damaged lane is unknown, not an absent lane or a crash", async () => {
  writeFileSync(join(state.dir, "lanes", "damaged.json"), "{broken");
  const snapshot = await laneStatus(deps(), "damaged");
  expect(snapshot.registryIncomplete).toBe(true);
  expect(snapshot.lanes).toEqual([]);
  expect(renderStatus(snapshot)).toContain("LANES unknown");
  expect(renderStatus(snapshot)).not.toContain("none open");
});

const malformed = [
  { suspended: "false" },
  { suspended: null },
  { persistent: "true" },
  { deliveryPaused: 1 },
  { expiresAt: "0" },
  { expiresAt: null },
  { expiresAt: [] },
  { expiresAt: Number.POSITIVE_INFINITY },
  { name: false },
  { cwd: 7 },
  { filter: [] },
  { monitorId: 33 },
  { sessionId: {} },
  { description: 5 },
  { command: false },
  { path: [] },
  { target: null },
  { argv: ["dori", null] },
];
for (const kind of ["omp", "legacy"] as const) {
  test.each(malformed)(`${kind} monitor fields are validated before counting: %j`, async (patch) => {
    const root =
      kind === "omp" ? join(state.dir, "monitors") : join(state.dir, "sessions", "session", "extensions", "terminal");
    mkdirSync(root, { recursive: true });
    const monitor =
      kind === "omp"
        ? { name: "watch", argv: ["dori", "watch"], cwd: "/repo" }
        : { monitorId: "mon_a", sessionId: "session", persistent: true };
    for (const [name, item] of [
      ["good", monitor],
      ["bad", { ...monitor, ...patch }],
    ] as const) {
      const data = JSON.stringify({ version: 1, sessionId: "session", monitors: [item] });
      writeFileSync(
        join(root, `${name}.json`),
        name === "bad" && patch.expiresAt === Number.POSITIVE_INFINITY
          ? data.replace('"expiresAt":null', '"expiresAt":1e309')
          : data,
      );
    }
    const snapshot = await laneStatus(deps());
    expect(snapshot.monitors).toEqual({ recorded: null, suspended: null, expired: null });
    const read = readMonitorManifests(deps().config.sessionsDir, [], join(state.dir, "monitors"));
    // Boot deliberately preserves legacy argv for command matching; status must still be unknown above.
    const legacyArgv = kind === "legacy" && Object.hasOwn(patch, "argv");
    expect(read.manifests).toHaveLength(legacyArgv ? 2 : 1);
    expect(read.errors).toHaveLength(legacyArgv ? 0 : 1);
    if (legacyArgv)
      expect(
        JSON.stringify(read.manifests.flatMap((m) => m.data.monitors).find((m) => m.argv !== undefined)?.argv),
      ).toBe('["dori",null]');
  });
}
