import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-offset.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a transition to another bot leaves a marker that fails closed under the old token too", () => {
  // Bot A's sidecar, a poll under B, and the sidecar replacement failing. Without the marker the sidecar
  // still names A, so a rollback to A matches it and accepts B's cursor — confirming away A's updates.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  const orig = console.log;
  const warns: string[] = [];
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    // Under B: `load()` sees A's sidecar and refuses the offset, so this run starts from 0.
    const underB = fileTgInboundStore(path, "222");
    expect(underB.load()).toBe(0);
    // The sidecar can no longer be replaced, as when it is squatted by a directory mid-run.
    rmSync(`${path}.bot`);
    mkdirSync(`${path}.bot`);
    underB.save(600);
  } finally {
    console.log = orig;
  }
  // The marker survives the failed transition, and both tokens now refuse the pair.
  expect(existsSync(`${path}.pending`)).toBe(true);
  for (const token of ["111", "222"]) expect(fileTgInboundStore(path, token).load()).toBe(0);
  // A fresh process reports why; the store above had already spent its one load warning.
  const fresh: string[] = [];
  const orig2 = console.log;
  console.log = (s?: unknown) => {
    fresh.push(String(s));
  };
  try {
    fileTgInboundStore(path, "111").load();
  } finally {
    console.log = orig2;
  }
  // The sidecar is a directory here, so the sidecar check fails closed before the marker is reached;
  // either way the pair is refused, which is what this test is about.
  expect(fresh.some((w) => w.includes("restarting from 0"))).toBe(true);
});

test("a completed transition clears its marker so the next start resumes normally", () => {
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  fileTgInboundStore(path, "222").save(600);
  expect(existsSync(`${path}.pending`)).toBe(false);
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("222");
  expect(fileTgInboundStore(path, "222").load()).toBe(600);
});

test("a cursor is not written when its bot could not be recorded", () => {
  // A bare cursor with no sidecar is accepted under any token by the next start, so a failed tag must
  // stop the cursor write rather than leaving the pair half-recorded.
  const path = join(state.dir, "telegram-offset");
  mkdirSync(`${path}.bot`, { recursive: true }); // the sidecar cannot be written
  const store = fileTgInboundStore(path, "111");
  const orig = console.log;
  console.log = () => {};
  try {
    store.save(900);
    expect(store.load()).toBe(900); // memory carries this run
  } finally {
    console.log = orig;
  }
  expect(existsSync(path)).toBe(false); // no untagged cursor on disk
});

test("a marker left by an interrupted transition is cleared by a later save", () => {
  // Otherwise every start returns 0 before reading anything, forever, and a one-shot drain can never
  // get past the first batch.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  writeFileSync(`${path}.pending`, "111");
  const store = fileTgInboundStore(path, "111");
  const orig = console.log;
  console.log = () => {};
  try {
    expect(store.load()).toBe(0); // the pair is not trusted yet
    store.save(600); // completes the transition
  } finally {
    console.log = orig;
  }
  expect(existsSync(`${path}.pending`)).toBe(false);
  expect(fileTgInboundStore(path, "111").load()).toBe(600);
});

test("an overlapping receiver cannot write its cursor beside the other bot's record", () => {
  // A is running, B takes over the same state dir and finishes its transition, then A saves again.
  // A's cached bot id still says A, so trusting the cache would put A's cursor beside B's record and
  // the next B start would adopt it, confirming away B's queued updates.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  const a = fileTgInboundStore(path, "111");
  expect(a.load()).toBe(500);
  // B completes its own transition while A is still holding its view of the world.
  fileTgInboundStore(path, "222").save(700);
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("222");
  const orig = console.log;
  const warns: string[] = [];
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    a.save(800);
  } finally {
    console.log = orig;
  }
  // A's save re-reads the sidecar, sees B, and does not leave its own cursor behind B's record.
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("111");
  expect(existsSync(`${path}.pending`)).toBe(false);
});

test("the old cursor stays readable by a release that predates the sidecar during a transition", () => {
  // A release from before this sidecar reads the bare cursor with `Number(...)` and ignores the marker,
  // so a cursor written ahead of the tag would be adopted by a rollback to it.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  const orig = console.log;
  console.log = () => {};
  try {
    // Under B the sidecar names A, so this is a transition; then the sidecar cannot be replaced, so the
    // transition cannot complete and the cursor must not have moved.
    const b = fileTgInboundStore(path, "222");
    expect(b.load()).toBe(0);
    rmSync(`${path}.bot`);
    mkdirSync(`${path}.bot`);
    b.save(700);
  } finally {
    console.log = orig;
  }
  // The old cursor is untouched: a rollback to 111 reads its own cursor, not B's.
  expect(Number(readFileSync(path, "utf8").trim())).toBe(500);
});
