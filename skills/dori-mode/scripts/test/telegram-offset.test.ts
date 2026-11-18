import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Http, HttpResponse } from "../src/messenger/http.ts";
import { pollTelegramInbound } from "../src/messenger/telegram-inbound.ts";
import { fileTgInboundStore } from "../src/messenger/telegram-offset.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { run } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = 5250;

type U = { update_id: number; message?: unknown; edited_message?: unknown };

const msg = (from: number, chatId: number, type: string, text: string) => ({
  message_id: 1,
  from: { id: from, is_bot: false, username: "owner" },
  chat: { id: chatId, type },
  text,
});

const telegramFake = (batches: U[][]) => {
  const http: Http = async (): Promise<HttpResponse> => {
    const batch = batches.shift() ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: batch }) };
  };
  return { http };
};

const mk = (http: Http): Telegram => new Telegram(http, fakeClock(0), "T");

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("the store creates its state dir on first save", async () => {
  const { http } = telegramFake([[{ update_id: 80, message: msg(OWNER, OWNER, "private", "fresh install") }]]);
  const store = fileTgInboundStore(join(state.dir, "nested", "deeper", "tg-off-8"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(store.load()).toBe(81);
});

test("an unparseable offset warns once across several polls and restarts from 0", async () => {
  writeFileSync(join(state.dir, "telegram-offset"), "not-a-number");
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
    // Three polls, no updates: nothing saves over the corrupt file, every poll loads it.
    const { http } = telegramFake([[], [], []]);
    const tg = mk(http);
    for (let i = 0; i < 3; i++) await pollTelegramInbound(tg, store, { ownerId: OWNER });
    expect(store.load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("WARN");
  expect(warns[0]).toContain("not a stored offset");
});

test("an offset file left empty by a torn write is reported, not read as offset 0", async () => {
  // A crash between truncate and write, or a full disk, leaves an empty file. `Number("")` is 0,
  // so the old reader treated it as a legitimate offset and silently replayed the retained history.
  writeFileSync(join(state.dir, "telegram-offset"), "");
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
    expect(store.load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("not a stored offset");
});

test("a saved offset survives as one whole file and never leaves a staged copy behind", () => {
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path);
  store.save(4242);
  expect(readFileSync(path, "utf8")).toBe("4242");
  // The write is staged and renamed, so no partial file is left for the next load to meet.
  expect(readdirSync(state.dir).filter((name) => name.includes(".staged"))).toEqual([]);
  expect(fileTgInboundStore(path).load()).toBe(4242);
});

test("a save that cannot land keeps this run from replaying what was already delivered", () => {
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path);
  store.save(10);
  // Make the target a directory: the rename fails, as it would on a read-only or full filesystem.
  rmSync(path);
  mkdirSync(path);
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    store.save(11);
    // Memory carries the offset, so the next poll asks past the update it already emitted.
    expect(store.load()).toBe(11);
  } finally {
    console.log = orig;
  }
  expect(warns.some((w) => w.includes("continuing from memory"))).toBe(true);
});

test("the receiver refuses a non-positive owner id instead of dropping every message", async () => {
  // A user id is positive; with -100 or 0 the gate matches nobody and the bot starts, prints
  // INBOUND_READY and then answers nothing, which looks like a broken bot rather than a bad setting.
  const cli = join(import.meta.dir, "../src/cli.ts");
  for (const value of ["-100", "0"]) {
    const r = await run(
      [
        "env",
        "DORI_TELEGRAM_TOKEN=1:x",
        `DORI_TELEGRAM_OWNER_ID=${value}`,
        process.execPath,
        cli,
        "inbound",
        "telegram",
      ],
      {
        timeoutMs: 20_000,
      },
    );
    expect({ value, code: r.code, err: r.err.trim(), out: r.out }).toEqual({
      value,
      code: 1,
      err: "DORI_TELEGRAM_OWNER_ID must be a positive user id",
      out: "",
    });
  }
}, 60_000);

test("the cursor is stored with the bot that produced it", () => {
  const path = join(state.dir, "telegram-offset");
  fileTgInboundStore(path, "111").save(500);
  expect(readFileSync(path, "utf8")).toBe("111 500");
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
  expect(readFileSync(path, "utf8")).toBe("111 4243");
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
