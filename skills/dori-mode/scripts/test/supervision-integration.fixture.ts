import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { type Held, withDeliveryLock } from "../src/delivery-lock.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Clock, Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import type { SupervisionDeps, SupervisionOptions } from "../src/supervision-observe.ts";
import type { TestState } from "./fakes.ts";

export const start = Date.parse("2026-01-01T00:00:00Z");
export const options: SupervisionOptions = {
  activityPaths: ["result.txt"],
  usageArgv: ["usage"],
  hungAfterMinutes: 0,
  staleAfterMinutes: 0,
};
const KEY = "integration-lane";

/**
 * One real lane in a real registry, with a report journal in its generation and one watched file in its working
 * directory. Git and usage are external commands answered by `run`; each reaches `hooks.command` by its name.
 */
export const integrationFixture = async (state: TestState) => {
  const work = join(state.dir, "work");
  fs.mkdirSync(work);
  const source = join(work, "result.txt");
  fs.writeFileSync(source, "first");
  const canonical = fs.realpathSync(source);
  const registry = new Registry(state.dir);
  const reports = new Reports(state.dir);
  const lane: Lane = {
    key: KEY,
    title: "integration",
    thread: "none",
    brief: "brief.md",
    done: "file result.txt",
    cwd: work,
    openedAt: new Date(start).toISOString(),
    lifecycleEpoch: "epoch-1",
    reportProtocol: "jsonl-v1",
  };
  await registry.write(lane);
  await reports.report(KEY, "milestone", "started", start, lane.lifecycleEpoch);
  let onWait = () => {};
  // A lock waiter's sleep yields to the event loop and never moves the clock, so no wait can run out.
  const clock: Clock & { at: number } = {
    at: start,
    now: () => clock.at,
    sleep: async () => {
      onWait();
      await Bun.sleep(1);
    },
  };
  // A supervision minute is also a filesystem minute: marks settle without real sleeps.
  const wall = Date.now();
  const spies: { mockRestore: () => void }[] = [spyOn(Date, "now").mockImplementation(() => wall + clock.at - start)];
  const hooks = { command: (_name: string) => {} };
  // Git status lists nothing, so the watched file is the only candidate; usage is a known reading.
  const run: Runner = async (argv) => {
    hooks.command(argv[0] ?? "");
    return { code: 0, out: argv[0] === "usage" ? '{"tokens":1,"costUsd":0}' : "", err: "" };
  };
  const lock = join(registry.dir, `${KEY}.deliver.lock`);
  const dir = join(state.dir, "lanes", KEY);
  const files = {
    journal: reports.path(KEY),
    observation: join(dir, "supervision.json"),
    cost: join(dir, "cost.jsonl"),
  };
  return {
    source,
    canonical,
    registry,
    reports,
    lane,
    clock,
    run,
    hooks,
    files,
    restore: () => {
      for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    },
    /** Resolves at the next delivery-lock wait of any sweep on this fixture's clock. */
    waiting: () => {
      const waited = Promise.withResolvers<void>();
      onWait = () => waited.resolve();
      return waited.promise;
    },
    snapshot: () => ({
      journal: fs.readFileSync(files.journal, "utf8"),
      observation: fs.existsSync(files.observation) ? fs.readFileSync(files.observation, "utf8") : null,
      cost: fs.existsSync(files.cost) ? fs.readFileSync(files.cost, "utf8") : null,
    }),
    /** Whether a peer such as tell or pause could take the delivery lock now: taken and released at once. */
    lockFree: (): boolean => {
      const held = takeLock(lock, Date.now(), (message) => new Error(message), { keepLiveOwner: true });
      if (typeof held === "string") return false;
      held();
      return true;
    },
    /**
     * At the first hash of the watched file, which follows the sweep's saved plan: captures that plan from disk, then
     * takes the real delivery lock as a peer (tell, pause, park or reopen) would, and holds it until `release`.
     * `free` is whether the peer took it there and then, without waiting: only a free lock is taken synchronously.
     */
    holdAtHash: (release: Promise<void>) => {
      const hold: { free: boolean; plan?: unknown; peer?: Promise<Held<void>> } = { free: false };
      const open = fs.openSync;
      spies.push(
        spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
          if (hold.peer === undefined && String(args[0]) === canonical) {
            hold.plan = JSON.parse(fs.readFileSync(files.observation, "utf8"));
            let entered = false;
            hold.peer = withDeliveryLock({ registry, clock }, KEY, async () => {
              entered = true;
              await release;
            });
            hold.free = entered;
          }
          return open(...args);
        }) as typeof fs.openSync),
      );
      return hold;
    },
    supervisor: (alert?: SupervisionDeps["alert"]) =>
      new Supervision(
        { stateDir: state.dir, run, clock, registry, ...(alert === undefined ? {} : { alert }) },
        options,
      ),
  };
};
