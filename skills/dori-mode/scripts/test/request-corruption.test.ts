import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { recordExecution } from "../src/lane-run.ts";
import { launchLane } from "../src/launch.ts";
import { parkLane } from "../src/park.ts";
import { reopenLane } from "../src/reopen.ts";
import { ReportError } from "../src/report-events.ts";
import { Reports } from "../src/reports.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";
import {
  CURRENT_RUN,
  NEXT_RUN,
  OLD_RUN,
  REQUEST,
  T0,
  TELEGRAM_REQUEST,
  provenanceOf,
  seedRequest,
} from "./request-fixtures.ts";

const historyDamage = [
  "malformed",
  "changed request",
  "duplicate start",
  "missing start",
  "changed generation",
  "changed native reference",
] as const;

const corruptExecutionHistory = (reports: Reports, key: string, damage: (typeof historyDamage)[number]) => {
  const path = reports.path(key);
  mkdirSync(dirname(path), { recursive: true });
  if (damage === "malformed") {
    appendFileSync(path, "not-json\n");
    return;
  }
  const common = {
    type: "execution" as const,
    key,
    at: new Date(T0).toISOString(),
    requestId: REQUEST,
    runId: OLD_RUN,
    generation: "previous-generation",
    text: "preserved previous execution",
  };
  const started = { ...common, phase: "started" as const };
  const bound = { ...common, phase: "bound" as const, nativeRef: provenanceOf(OLD_RUN).nativeRef };
  reports.append(started);
  reports.append(bound);
  reports.append(
    {
      "changed request": { ...bound, requestId: TELEGRAM_REQUEST },
      "duplicate start": started,
      "missing start": { ...bound, runId: NEXT_RUN },
      "changed generation": { ...bound, generation: "foreign-generation" },
      "changed native reference": { ...bound, nativeRef: { ...bound.nativeRef, sessionId: "foreign-native" } },
    }[damage],
  );
};

test.each(["malformed", "conflicting", "prior-conflicting"])(
  "a %s execution journal cannot discard completed checkpoint effects",
  async (damage) => {
    await withDiscordCli(async (f) => {
      const stateDir = dirname(f.tmp);
      const { lane } = await seedRequest(stateDir);
      const path = new Reports(stateDir).path(lane.key);
      const last = new Reports(stateDir).events(lane.key).at(-1);
      if (!last) throw new Error("missing seeded execution");
      appendFileSync(
        path,
        damage === "malformed"
          ? "not-json\n"
          : `${JSON.stringify({ ...last, runId: damage === "prior-conflicting" ? OLD_RUN : CURRENT_RUN, requestId: "telegram:1:2" })}\n`,
      );
      const damaged = readFileSync(path, "utf8");
      const args = [
        "checkpoint",
        lane.key,
        "--step",
        "pushed",
        "--result",
        "ok",
        "--evidence",
        "log",
        "--remote-effect",
        "push:abc",
      ];
      const environment = { DORI_LANE_RUN: CURRENT_RUN };
      const first = await f.invoke(args, { environment });
      expect([first.code, first.err]).toEqual([0, ""]);
      const receipt = JSON.parse(first.out);
      expect(receipt.checkpoint.remoteEffects).toEqual(["push:abc"]);
      expect(receipt.checkpoint.provenance).toBeUndefined();
      expect(receipt.attribution).toMatchObject({
        state: "unverified",
        reason: expect.stringContaining("Execution journal invalid"),
      });
      const journal = new Checkpoints(stateDir);
      expect(journal.latest(lane)).toBeNull();
      const replay = await f.invoke(args, { environment });
      expect(JSON.parse(replay.out)).toMatchObject({ checkpoint: receipt.checkpoint, unchanged: true });
      expect(journal.read(lane.key)).toHaveLength(1);
      const report = await f.invoke(["report", lane.key, "--kind", "milestone", "--text", "must refuse"], {
        environment,
      });
      expect(report.code).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(damaged);
    });
  },
);

test.each(historyDamage)(
  "a %s sourced launch journal is refused before creating or registering a pane",
  async (damage) => {
    const state = withState();
    try {
      const world = newWorld();
      const base = depsFor(world, fakeClock(T0), state.dir);
      const deps = {
        ...base,
        run: async (argv: readonly string[]) => {
          if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
            world.calls.push([...argv]);
            return {
              code: 0,
              out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
              err: "",
            };
          }
          return base.run(argv);
        },
      };
      const key = "corrupt-launch";
      const reports = new Reports(state.dir);
      const path = reports.path(key);
      corruptExecutionHistory(reports, key, damage);
      const damaged = readFileSync(path, "utf8");
      const brief = join(state.dir, "brief.md");
      writeFileSync(brief, "# brief\n");
      await expect(
        launchLane(deps, { key, title: "t", brief, done: "file /done", requestId: REQUEST }),
      ).rejects.toThrow(ReportError);
      expect(world.calls.some((args) => args[1] === "tab" && args[2] === "create")).toBe(false);
      expect(await deps.registry.read(key)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe(damaged);
      expect(readFileSync(brief, "utf8")).toBe("# brief\n");
      expect(world.calls).toEqual([]);
    } finally {
      state.done();
    }
  },
);

test.each(historyDamage)("a %s sourced reopen journal is refused before a new pane or generation", async (damage) => {
  const f = await lifecycleFixture();
  try {
    const lane = { ...f.lane, requestId: REQUEST, runId: CURRENT_RUN };
    await f.deps.registry.write(lane);
    recordExecution(f.state.dir, lane, T0);
    const parked = await parkLane(f.deps, lane, "hold");
    expect(parked.code).toBe(0);
    const before = await f.deps.registry.read(lane.key);
    const reports = new Reports(f.state.dir);
    const path = reports.path(lane.key);
    corruptExecutionHistory(reports, lane.key, damage);
    const damaged = readFileSync(path, "utf8");
    const savedSession = readFileSync(f.file, "utf8");
    f.world.calls.length = 0;
    await expect(reopenLane(f.deps, parked.lane)).rejects.toThrow(ReportError);
    expect(f.creates()).toBe(0);
    expect(f.world.calls).toEqual([]);
    expect(readFileSync(f.file, "utf8")).toBe(savedSession);
    expect(await f.deps.registry.read(lane.key)).toEqual(before);
    expect(readFileSync(path, "utf8")).toBe(damaged);
  } finally {
    f.state.done();
  }
});
