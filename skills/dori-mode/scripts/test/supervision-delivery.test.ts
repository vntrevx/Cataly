import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Checkpoints } from "../src/checkpoints.ts";
import { fileEvidence } from "../src/evidence.ts";
import { Supervision } from "../src/supervision.ts";
import { type TestState, withState } from "./fakes.ts";
import { coverageFixture } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

for (const failedDelivery of [false, true]) {
  for (const update of ["report", "repeat", "evidence", "checkpoint", "question", "halted", "done"] as const) {
    test(`${update} during an awaited ${failedDelivery ? "failed" : "successful"} alert reconciles against real evidence and explicit state`, async () => {
      let attempts = 0;
      const f = coverageFixture(state, async () => {
        ++attempts;
        await Promise.resolve();
        ++f.clock.at;
        const source = f.paths[999];
        if (!source) throw new Error("fixture needs its final candidate");
        if (update === "evidence" || update === "checkpoint") writeFileSync(source, "work during delivery");
        // Reattach the recorded ref: an extra explicit file read is not part of the observer's 256-path budget.
        const refs =
          update === "report"
            ? []
            : update === "repeat"
              ? f
                  .refs()
                  .filter((ref) => ref.ref === source)
                  .slice(-1)
              : [fileEvidence(source, f.repo)];
        if (update === "repeat") expect(refs).toHaveLength(1);
        if (update === "checkpoint") {
          new Checkpoints(state.dir).write(
            f.lane.key,
            { step: "during-alert", result: "file changed", evidence: [source], remoteEffects: [], evidenceRefs: refs },
            f.clock.at,
          );
        } else {
          const kind = update === "question" || update === "halted" || update === "done" ? update : "milestone";
          f.reports.report(f.lane.key, kind, "reported during delivery", f.clock.at, refs);
        }
        if (failedDelivery && attempts === 1) throw new Error("delivery unavailable");
      });
      for (let window = 0; window < 7; window++) await f.sweep();
      const before = f.observation().lastEvidenceAt;
      if (failedDelivery) await expect(f.sweep()).rejects.toThrow("alert delivery failed");
      else await f.sweep();
      const held = update === "report" || update === "repeat";
      const changed = update === "evidence" || update === "checkpoint";
      const expectedState = held ? "stalled" : update === "question" ? "blocked" : changed ? "running" : update;
      expect(f.reports.read(f.lane.key)?.state).toBe(expectedState);
      expect(f.observation().hung).toBe(held);
      expect(f.observation().lastEvidenceAt).toBe(changed ? new Date(f.clock.at).toISOString() : before);
      const next = (await f.sweep()).result;
      expect(next.coverageComplete).toBe(false);
      expect(next.state).toBe(expectedState);
      expect(next.heldHung).toBe(held);
      expect(attempts).toBe(held && failedDelivery ? 2 : 1);
      for (let window = 0; window < 2; window++) expect((await f.sweep()).result.alerts).toEqual([]);
      expect(attempts).toBe(held && failedDelivery ? 2 : 1);
    });
  }
}

test("a reached ceiling still blocks when an awaited alert reports fresh work", async () => {
  const f = coverageFixture(state);
  const source = f.paths[0];
  if (!source) throw new Error("fixture needs its first candidate");
  const supervisor = new Supervision(
    {
      stateDir: state.dir,
      clock: f.clock,
      run: async () => ({ code: 0, out: JSON.stringify({ tokens: 2 }), err: "" }),
      alert: async () => {
        await Promise.resolve();
        ++f.clock.at;
        f.reports.report(f.lane.key, "milestone", "new work", f.clock.at, [fileEvidence(source, f.repo)]);
      },
    },
    { gitActivity: false, usageArgv: ["usage"], defaults: { tokens: 1 } },
  );
  const result = await supervisor.sweep(f.lane, "Working 21m");
  expect(result.usage?.tokens).toBe(2);
  expect(result.state).toBe("blocked");
  expect(result.heldHung).toBe(false);
  expect(f.reports.read(f.lane.key)?.lastReport?.text).toBe("tokens ceiling reached (1)");
});
