import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { Lane } from "../src/registry.ts";
import { Supervision } from "../src/supervision.ts";
import { fakeClock, type TestState, withState } from "./fakes.ts";
import { integrationFixture, options, start } from "./supervision-integration.fixture.ts";

let state: TestState;
let restore = () => {};
beforeEach(() => {
  state = withState();
});
afterEach(() => {
  restore();
  restore = () => {};
  state.done();
});

const records = (text: string | null): Record<string, unknown>[] =>
  (text ?? "").split("\n").flatMap((line) => (line ? [JSON.parse(line) as Record<string, unknown>] : []));

test("observation I/O runs with the delivery lock free; alerts and every write retain its protection", async () => {
  const f = await integrationFixture(state);
  restore = f.restore;
  const free = new Set<string>();
  const busy = new Set<string>();
  const probe = (at: string) => {
    (f.lockFree() ? free : busy).add(at);
  };
  const locked = new Set<string>();
  const unlocked = new Set<string>();
  const wrote = (what: string) => {
    (f.lockFree() ? unlocked : locked).add(what);
  };
  f.hooks.command = probe;
  const open = fs.openSync;
  const lstat = fs.lstatSync;
  const rename = fs.renameSync;
  const append = fs.appendFileSync;
  const spies = [
    spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === f.canonical) probe("hash");
      return open(...args);
    }) as typeof fs.openSync),
    spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      // Only the new-hung recheck of the known candidates tolerates absence.
      if (String(args[0]) === f.source && args[1]?.throwIfNoEntry === false) probe("recheck");
      return lstat(...args);
    }) as typeof fs.lstatSync),
    spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === f.files.observation) wrote("observation");
      rename(...args);
    }) as typeof fs.renameSync),
    spyOn(fs, "appendFileSync").mockImplementation(((...args: Parameters<typeof fs.appendFileSync>) => {
      if (String(args[0]) === f.files.journal) wrote("journal");
      if (String(args[0]) === f.files.cost) wrote("cost");
      append(...args);
    }) as typeof fs.appendFileSync),
  ];
  const alerts: string[] = [];
  try {
    const supervisor = f.supervisor((_lane, message) => {
      probe("alert");
      alerts.push(message);
    });
    expect((await supervisor.sweep(f.lane, "Working 21m")).hung).toBe(false);
    f.clock.at += 60_000;
    // The same call grew past both thresholds over a whole quiet cycle: a new verdict, rechecked and alerted.
    expect(await supervisor.sweep(f.lane, "Working 22m")).toMatchObject({ hung: true, state: "stalled" });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(alerts).toHaveLength(1);
  expect({ free: [...free].sort(), busy: [...busy] }).toEqual({
    free: ["git", "hash", "recheck", "usage"],
    busy: ["alert"],
  });
  expect({ locked: [...locked].sort(), unlocked: [...unlocked] }).toEqual({
    locked: ["cost", "journal", "observation"],
    unlocked: [],
  });
  expect(f.lockFree()).toBe(true);
});

for (const supervised of [false, true]) {
  test(`a generation replaced after the plan records nothing and keeps the new generation's ${supervised ? "supervision state" : "journal"}`, async () => {
    const f = await integrationFixture(state);
    restore = f.restore;
    let usage = 0;
    f.hooks.command = (name) => {
      if (name === "usage") usage++;
    };
    const release = Promise.withResolvers<void>();
    const hold = f.holdAtHash(release.promise);
    const waiting = f.waiting();
    const stale = f.supervisor().sweep(f.lane, "Working 21m");
    try {
      // The stale sweep saved its plan, read the file without the lock, and now waits for the lock to commit.
      await waiting;
      expect(hold.free).toBe(true);
      expect(hold.plan).toEqual({
        openedAt: f.lane.openedAt,
        generation: "epoch-1",
        coverage: expect.objectContaining({ pending: [f.source] }),
      });
      // Under the peer's lock the lane is reopened in a new generation, which reports and may already be supervised.
      const next: Lane = { ...f.lane, openedAt: new Date(start + 1_000).toISOString(), lifecycleEpoch: "epoch-2" };
      await f.registry.write(next);
      await f.reports.report(next.key, "milestone", "new generation", start + 1_000, next.lifecycleEpoch);
      const successor = new Supervision({ stateDir: state.dir, run: f.run, clock: fakeClock(start + 1_000) }, options);
      if (supervised) await successor.sweep(next, "Working 1m");
      const current = f.snapshot();
      release.resolve();
      expect((await hold.peer)?.ok).toBe(true);
      expect(await stale).toMatchObject({ enabled: false, state: null, alerts: [], usage: null });
      expect(f.snapshot()).toEqual(current);
      expect(usage).toBe(supervised ? 2 : 1);
      // Nothing of the stale generation: no usage reading, no observer activity, no observation of its own.
      expect(records(current.cost).map((reading) => reading["openedAt"])).toEqual(supervised ? [next.openedAt] : []);
      expect(records(current.journal).map((event) => event["generation"])).toEqual(
        supervised ? ["epoch-1", "epoch-2", "epoch-2"] : ["epoch-1", "epoch-2"],
      );
      const observation = JSON.parse(current.observation ?? "null");
      if (supervised) expect(observation).toMatchObject({ openedAt: next.openedAt, generation: "epoch-2" });
      else expect(observation).toEqual(hold.plan);
    } finally {
      release.resolve();
      await stale;
    }
  });
}

test("a same-generation commit made while the sweep observed is kept, and the stale candidate records nothing", async () => {
  const f = await integrationFixture(state);
  restore = f.restore;
  const release = Promise.withResolvers<void>();
  const hold = f.holdAtHash(release.promise);
  const waiting = f.waiting();
  const stale = f.supervisor().sweep(f.lane, "Working 21m");
  try {
    await waiting;
    expect(hold.free).toBe(true);
    // A second supervisor of the same generation completes a sweep over the very same plan meanwhile.
    const other = new Supervision({ stateDir: state.dir, run: f.run, clock: fakeClock(start + 1_000) }, options);
    expect((await other.sweep(f.lane, "Working 21m")).enabled).toBe(true);
    const current = f.snapshot();
    expect(JSON.parse(current.observation ?? "null")).toMatchObject({ generation: "epoch-1", at: start + 1_000 });
    release.resolve();
    expect((await hold.peer)?.ok).toBe(true);
    expect(await stale).toMatchObject({ enabled: false });
    // The stale candidate neither replaced that state nor added a reading or a duplicate observer record.
    expect(f.snapshot()).toEqual(current);
    expect(records(current.cost)).toHaveLength(1);
    const observed = records(current.journal).filter((event) => event["text"] === "Observed filesystem evidence");
    expect(observed).toHaveLength(1);
  } finally {
    release.resolve();
    await stale;
  }
});
