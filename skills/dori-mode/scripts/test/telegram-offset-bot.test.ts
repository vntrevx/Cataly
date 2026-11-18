import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-offset.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const quiet = (fn: () => void): string[] => {
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return warns;
};

test("each bot keeps its own cursor file", () => {
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  fileTgInboundStore(path, "222").save(700);
  expect(readFileSync(`${path}.111`, "utf8")).toBe("500");
  expect(readFileSync(`${path}.222`, "utf8")).toBe("700");
  expect(fileTgInboundStore(path, "111").load()).toBe(500);
  expect(fileTgInboundStore(path, "222").load()).toBe(700);
});

test("a second bot never moves the first bot's cursor", () => {
  // The whole point: update ids are per bot, so a cursor handed to another bot makes getUpdates
  // confirm — and discard — everything that bot has waiting.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(48000);
  const before = readFileSync(`${path}.111`, "utf8");
  fileTgInboundStore(path, "222").save(12);
  expect(readFileSync(`${path}.111`, "utf8")).toBe(before);
});

test("a fresh bot starts at 0 rather than inheriting another bot's cursor", () => {
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(48000);
  expect(fileTgInboundStore(path, "222").load()).toBe(0);
});

test("the shared file seeds the first bot only when its bot is verifiable, and is never written again", () => {
  // `path` is every pre-split install's cursor. A rollback to such a release reads it with Number(...),
  // so it must keep the value that release left; only a copy moves into the per-bot file.
  const path = join(state.dir, "telegram-offset");
  writeFileSync(path, "269422565");
  const warns = quiet(() => {
    expect(fileTgInboundStore(path, "111", "111").load()).toBe(269422565);
  });
  expect(warns.some((w) => w.includes("predates per-bot cursors"))).toBe(true);
  fileTgInboundStore(path, "111", "111").save(269422566);
  expect(readFileSync(`${path}.111`, "utf8")).toBe("269422566");
  expect(readFileSync(path, "utf8")).toBe("269422565"); // untouched for the old release
  expect(Number(readFileSync(path, "utf8").trim())).toBe(269422565);
});

test("an unverifiable shared cursor is not adopted, because it may belong to another bot", () => {
  // A token changed before the upgrade: the shared cursor is the OLD bot's, and adopting it would make
  // getUpdates confirm — and discard — everything the new bot has waiting.
  const path = join(state.dir, "telegram-offset");
  writeFileSync(path, "269422565");
  const warns = quiet(() => {
    expect(fileTgInboundStore(path, "222").load()).toBe(0);
    // A record naming a different bot is equally not this bot's.
    expect(fileTgInboundStore(path, "333", "111").load()).toBe(0);
  });
  expect(warns.filter((w) => w.includes("its bot is unrecorded")).length).toBeGreaterThan(0);
});

test("a torn or unparseable cursor file is reported instead of read as offset 0", () => {
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  writeFileSync(`${path}.111`, "");
  const warns = quiet(() => {
    expect(fileTgInboundStore(path, "111").load()).toBe(0);
  });
  expect(warns.some((w) => w.includes("is not a stored offset"))).toBe(true);
});

test("a malformed token falls back to the shared path instead of a file no bot owns", () => {
  // Such a token cannot authenticate, so there is no bot to separate it from.
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "not-a-bot").save(700);
  expect(readFileSync(path, "utf8")).toBe("700");
  expect(existsSync(`${path}.not-a-bot`)).toBe(false);
});

test("a save that cannot land keeps this run from replaying what was already delivered", () => {
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path, "111");
  store.save(10);
  mkdirSync(`${path}.111.bak`, { recursive: true });
  // Make the target a directory: the rename fails, as on a read-only or full filesystem.
  const target = `${path}.111`;
  const content = readFileSync(target, "utf8");
  require("node:fs").rmSync(target);
  mkdirSync(target);
  const warns = quiet(() => {
    store.save(11);
    expect(store.load()).toBe(11); // memory carries this run
  });
  expect(warns.some((w) => w.includes("continuing from memory"))).toBe(true);
  expect(content).toBe("10");
});
