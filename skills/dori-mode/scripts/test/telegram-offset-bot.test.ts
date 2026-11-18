import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
