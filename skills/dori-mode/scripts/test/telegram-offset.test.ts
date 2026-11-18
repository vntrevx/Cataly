import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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

test("a short write does not persist a truncated offset that would replay the updates in between", () => {
  // Every prefix of a decimal is a valid offset, so `123` written instead of `123456` loads cleanly and
  // resumes an hour behind. The save must fail instead, leaving the previous offset whole.
  const path = join(state.dir, "telegram-offset");
  const store = fileTgInboundStore(path, "111");
  store.save(123_456);
  expect(readFileSync(`${path}.111`, "utf8")).toBe("123456");
  // A filesystem that accepts only part of the bytes, as a short write on a nearly full disk can.
  const real = fs.writeSync;
  const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, data: string | Uint8Array) => {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    return real(fd, text.slice(0, 3));
  }) as typeof fs.writeSync);
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    store.save(123_457);
    expect(store.load()).toBe(123_457); // memory carries this run, so nothing is re-delivered
  } finally {
    spy.mockRestore();
    console.log = orig;
  }
  // The file still holds the whole previous offset, not the truncated one.
  expect(readFileSync(`${path}.111`, "utf8")).toBe("123456");
  expect(warns.some((w) => w.includes("short write"))).toBe(true);
  expect(readdirSync(state.dir).filter((n) => n.includes(".staged"))).toEqual([]);
});
