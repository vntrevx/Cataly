import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

for (const added of [false, true]) {
  test(`usage finishes before discovery and observation of ${added ? "a new candidate" : "a current-window change"}`, async () => {
    const f = coverageFixture(state);
    const path = added ? join(f.scaffold, "new-during-usage.txt") : f.paths[768];
    if (!path) throw new Error("fixture needs its current-window candidate");
    let turn = 0;
    const run: Runner = async (argv, options) => {
      if (argv[0] !== "usage") return git(argv, options);
      await Promise.resolve();
      if (turn === 7) writeFileSync(path, "work while the usage command was awaited");
      return { code: 0, out: '{"tokens":0,"costUsd":0}', err: "" };
    };
    const supervisor = new Supervision(
      { stateDir: state.dir, clock: f.clock, run },
      { hungAfterMinutes: 0, staleAfterMinutes: 0, usageArgv: ["usage"] },
    );
    for (; turn < 8; turn++) {
      f.clock.at = start + turn * 60_000;
      const result = await f.settle(() => supervisor.sweep(f.lane, `Working ${21 + turn}m`));
      expect(result.hung).toBe(false);
      expect(result.heldHung).toBe(false);
      expect(result.state).toBe("running");
    }
    if (added) expect(f.observation().coverage.deferred).toContain(path);
    else expect(f.refs().findLast((ref) => ref.ref === path)?.fingerprint).toBe(fileEvidence(path, f.repo).fingerprint);
  });
}
