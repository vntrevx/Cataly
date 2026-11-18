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

test("the cursor stays a bare offset, with the bot recorded beside it", () => {
  // Older releases read this file with `Number(...)`, and a rollback to one of them must still find an
  // offset it understands; the bot id lives in its own file so the shared format never changes.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  expect(readFileSync(path, "utf8")).toBe("500");
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("111");
  expect(fileTgInboundStore(path, "111").load()).toBe(500);
});

test("a cursor left by another bot is not carried over, because it would confirm away that bot's updates", () => {
  // update_ids are per bot and a bot's are far below another bot's, so a carried offset makes
  // getUpdates confirm — and discard — everything the new bot has waiting, silently.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(48000);
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    expect(fileTgInboundStore(path, "222").load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("belongs to bot 111, not 222");
});

test("a bare offset from before the bot was recorded still loads", () => {
  // An existing install must not restart from 0 on upgrade; the next save records the bot.
  const path = join(state.dir, "telegram-offset");
  writeFileSync(path, "4242");
  expect(fileTgInboundStore(path, "111").load()).toBe(4242);
  fileTgInboundStore(path, "111").save(4243);
  expect(readFileSync(path, "utf8")).toBe("4243");
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("111");
});

test("a load warning does not silence the save warning", () => {
  // One flag for both meant a torn offset at start made every later save failure invisible, and the
  // run looked healthy while persisting nothing.
  const path = join(state.dir, "telegram-offset");
  writeFileSync(path, "");
  const store = fileTgInboundStore(path, "111");
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    expect(store.load()).toBe(0); // warns: not a stored offset
    rmSync(path);
    mkdirSync(path); // the rename cannot land, as on a read-only or full filesystem
    store.save(7);
    expect(store.load()).toBe(7); // memory carries this run
  } finally {
    console.log = orig;
  }
  expect(warns.filter((w) => w.includes("not a stored offset"))).toHaveLength(1);
  expect(warns.filter((w) => w.includes("continuing from memory"))).toHaveLength(1);
});

test("a sidecar that exists but cannot be read fails closed instead of trusting an unknown bot", () => {
  // Only a missing sidecar is the pre-upgrade case. An unreadable one is exactly the situation where
  // the token may have changed, and accepting the offset there could confirm away this bot's updates.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  rmSync(`${path}.bot`);
  mkdirSync(`${path}.bot`); // present but unreadable as a file
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    expect(fileTgInboundStore(path, "222").load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("is unreadable");
});

test("a sidecar left empty by a torn write fails closed instead of reading as absent", () => {
  // Absent is the pre-upgrade fallback; empty is a write that did not finish, and it is the same
  // situation as an unreadable sidecar — the bot is unknown, so the offset must not be trusted.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  writeFileSync(`${path}.bot`, "");
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    expect(fileTgInboundStore(path, "222").load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("is not a bot id");
});

test("a malformed token prefix is not recorded as a bot id that could never match again", () => {
  // `token.split(":")[0]` is the bot id only for a well-formed token. Recording "abc" would make every
  // later start fail closed on a sidecar that can never match, replaying 24 hours each time.
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path, "abc");
  store.save(700);
  expect(readFileSync(path, "utf8")).toBe("700");
  expect(existsSync(`${path}.bot`)).toBe(false);
  expect(fileTgInboundStore(path, "abc").load()).toBe(700);
});

test("a first save records the bot before the offset, so a crash cannot leave an untagged cursor", () => {
  // With no sidecar yet, the offset must not land alone: an untagged cursor is accepted under any
  // token by the next start, which is the discard this sidecar exists to prevent.
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path, "111");
  const orig = console.log;
  console.log = () => {};
  try {
    // The offset write cannot land, as on a full disk; the bot record is written first anyway.
    mkdirSync(path, { recursive: true });
    store.save(500);
  } finally {
    console.log = orig;
  }
  expect(readFileSync(`${path}.bot`, "utf8")).toBe("111");
  // And a later token swap is therefore still detected, even though the offset never landed.
  rmSync(path, { recursive: true, force: true });
  expect(fileTgInboundStore(path, "222").load()).toBe(0);
});

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
