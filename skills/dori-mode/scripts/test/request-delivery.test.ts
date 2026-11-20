import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { recordExecution, runContext } from "../src/lane-run.ts";
import { recordSent } from "../src/owes.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { Reports, reportId } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import {
  CURRENT_RUN,
  REQUEST,
  SLACK_REQUEST,
  T0,
  TELEGRAM_REQUEST,
  seedRequest,
  sourcedLane,
} from "./request-fixtures.ts";

const KEY = sourcedLane.key;
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const PARTS = ["333333333333333333", "444444444444444444"];
const DELIVERY = `discord:${CHANNEL}:${PARTS[0]}`;
const MIN = 60_000;
const current = { environment: { DORI_LANE_RUN: CURRENT_RUN } };
const linked = {
  state: "linked",
  deliveryId: DELIVERY,
  requestId: REQUEST,
  channel: CHANNEL,
  remoteIds: PARTS,
  at: T0,
} as const;

type Fixture = Parameters<Parameters<typeof withDiscordCli>[0]>[0];
const reportNow = async (f: Fixture, text = "Answer ready"): Promise<{ id: string; at: string }> => {
  const result = await f.invoke(["report", KEY, "--kind", "milestone", "--text", text, "--json"], current);
  expect(result.code).toBe(0);
  return JSON.parse(result.out);
};

test("relayed --delivery links only the exact Discord request's complete receipt", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await seedRequest(stateDir);
    const report = await reportNow(f);
    await recordSent(stateDir, CHANNEL, MESSAGE, PARTS, Date.parse(report.at) + 1);
    const relayed = await f.invoke(["relayed", KEY, "--report", report.id, "--delivery", DELIVERY, "--json"]);
    expect([relayed.code, relayed.err]).toEqual([0, ""]);
    const delivery = { ...linked, at: Date.parse(report.at) + 1 };
    expect(JSON.parse(relayed.out)).toEqual({ key: KEY, reportId: report.id, delivery });
    const lane = await new Registry(stateDir).read(KEY);
    expect([lane?.lastPostedReportId, lane?.lastPostedReportDelivery]).toEqual([report.id, delivery]);

    // A later report relayed without a receipt never inherits the earlier link.
    const next = await reportNow(f, "Second answer");
    const plain = await f.invoke(["relayed", KEY, "--report", next.id, "--json"]);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.out).delivery.state).toBe("unverified");
    const status = await f.invoke(["status", KEY, "--json"]);
    expect(JSON.parse(status.out).lanes[0].lastDelivery).toMatchObject({
      reportId: next.id,
      receipt: { state: "unverified" },
    });
  });
});

const refusals: [string, (stateDir: string, reportAt: number) => Promise<void>, string][] = [
  ["missing", () => Promise.resolve(), DELIVERY],
  ["external", (dir, at) => recordSent(dir, CHANNEL, "555555555555555555", PARTS, at + 1), DELIVERY],
  ["older", (dir, at) => recordSent(dir, CHANNEL, MESSAGE, PARTS, at - 1), DELIVERY],
  [
    "ambiguous",
    async (dir, at) => {
      await recordSent(dir, CHANNEL, MESSAGE, PARTS, at + 1);
      await recordSent(dir, CHANNEL, MESSAGE, PARTS, at + 2);
    },
    DELIVERY,
  ],
  ["partial", (dir, at) => recordSent(dir, CHANNEL, MESSAGE, PARTS, at + 1), `discord:${CHANNEL}:${PARTS[1]}`],
];

test.each(refusals)(
  "relayed --delivery refuses a %s receipt and leaves the lane unacknowledged",
  async (_name, seed, id) => {
    await withDiscordCli(async (f) => {
      const stateDir = dirname(f.tmp);
      await seedRequest(stateDir);
      const report = await reportNow(f);
      await seed(stateDir, Date.parse(report.at));
      const before = await new Registry(stateDir).read(KEY);
      const relayed = await f.invoke(["relayed", KEY, "--report", report.id, "--delivery", id]);
      expect(relayed.code).not.toBe(0);
      expect(relayed.err).toContain("relayed:");
      expect(await new Registry(stateDir).read(KEY)).toEqual(before);
    });
  },
);

test.each([TELEGRAM_REQUEST, SLACK_REQUEST])(
  "a %s request is relayed unverified and refuses a Discord receipt",
  async (request) => {
    await withDiscordCli(async (f) => {
      const stateDir = dirname(f.tmp);
      await seedRequest(stateDir, request);
      const report = await reportNow(f);
      await recordSent(stateDir, CHANNEL, MESSAGE, PARTS, Date.parse(report.at) + 1);
      const refused = await f.invoke(["relayed", KEY, "--report", report.id, "--delivery", DELIVERY]);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("recorded Discord request");
      expect((await new Registry(stateDir).read(KEY))?.lastPostedReportId).toBeUndefined();
      const plain = await f.invoke(["relayed", KEY, "--report", report.id, "--json"]);
      expect(plain.code).toBe(0);
      expect(JSON.parse(plain.out).delivery.state).toBe("unverified");
    });
  },
);

test("an unsourced lane cannot link a Discord receipt through relayed --delivery", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const { requestId: _r, runId: _u, ...unsourced } = sourcedLane;
    await new Registry(stateDir).write(unsourced);
    const report = await reportNow(f);
    await recordSent(stateDir, CHANNEL, MESSAGE, PARTS, Date.parse(report.at) + 1);
    const refused = await f.invoke(["relayed", KEY, "--report", report.id, "--delivery", DELIVERY]);
    expect(refused.code).not.toBe(0);
    expect((await new Registry(stateDir).read(KEY))?.lastPostedReportDelivery).toBeUndefined();
  });
});

test.each([
  [REQUEST, "discord:111111111111111111"],
  [TELEGRAM_REQUEST, "telegram:-1001234567"],
  [SLACK_REQUEST, "slack:C0123ABCD"],
])(
  "a threadReply hook post for %s stays unverified and drops the previous linked receipt",
  async (requestId, thread) => {
    const state = withState();
    try {
      const world = newWorld();
      world.screen = "Working (1m)";
      const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
        hooks: { threadReply: ["notify", "{text}"] },
      });
      const lane: Lane = {
        key: "hook-lane",
        title: "hook",
        thread,
        pane: "w:p7",
        brief: "/b",
        done: "file /done",
        openedAt: new Date(T0).toISOString(),
        reportProtocol: "jsonl-v1",
        requestId,
        runId: CURRENT_RUN,
        lastPostedReportId: "previous-report",
        lastPostedReportDelivery: { ...linked, requestId },
        lastRelayedAt: T0,
        lastNudgeAt: T0 + 30 * MIN,
      };
      await deps.registry.write(lane);
      recordExecution(state.dir, lane, T0);
      recordExecution(state.dir, lane, T0, "native-hook");
      const reports = new Reports(state.dir);
      const context = runContext(reports, lane, CURRENT_RUN);
      const entry = reports.report(lane.key, "milestone", "hook detail", T0, undefined, undefined, context?.provenance);
      expect(entry.provenance?.nativeRef?.sessionId).toBe("native-hook");
      const acts = await freshnessTick(deps, state.dir);
      expect(acts.filter((a) => a.kind === "posted").map((a) => a.detail)).toEqual([
        expect.stringContaining("delivery=unverified"),
      ]);
      expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
      const stored = await deps.registry.read(lane.key);
      expect(stored?.lastPostedReportId).toBe(reportId(entry));
      expect(stored?.lastPostedReportDelivery).toEqual({ state: "unverified", reason: expect.any(String) });
    } finally {
      state.done();
    }
  },
);
