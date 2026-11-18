import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Http, HttpResponse } from "../src/messenger/http.ts";
import { inboundLagLog } from "../src/messenger/telegram-lag.ts";
import { pollTelegramInbound } from "../src/messenger/telegram-inbound.ts";
import { fileTgInboundStore } from "../src/messenger/telegram-offset.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = 5250;
const OTHER = 6612;

const state = withState();
beforeEach(() => mkdirSync(state.dir, { recursive: true }));
afterEach(() => state.done());

type U = { update_id: number; message?: unknown; edited_message?: unknown };

const msg = (from: number, chatId: number, type: string, text: string) => ({
  message_id: 1,
  from: { id: from, is_bot: false, username: from === OWNER ? "owner" : "someone" },
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

test("dated owner intake records lag from the edit's own date, without changing cursor or owner filtering", async () => {
  const date = 1_700_000_000;
  const { http } = telegramFake([
    [
      { update_id: 100, message: { ...msg(OWNER, OWNER, "private", "first"), date } },
      {
        update_id: 101,
        edited_message: { ...msg(OWNER, OWNER, "private", "edited"), date, edit_date: date + 2 },
      },
      { update_id: 102, message: msg(OWNER, OWNER, "private", "without date") },
      { update_id: 103, message: { ...msg(OTHER, OTHER, "private", "not the owner"), date } },
    ],
  ]);
  const path = join(state.dir, "telegram-lag.jsonl");
  const record = inboundLagLog(path);
  const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
  await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (inbound) => record(inbound, 1_700_000_002_250));
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { updateId: number; kind: string; lagMs?: number });
  // The edit happened 2s after the message, so it arrived 250ms late. Measuring it from the
  // original message's date recorded the message's age as receive lag, which is not a delay.
  expect(records.map(({ updateId, kind, lagMs }) => [updateId, kind, lagMs])).toEqual([
    [100, "message", 2250],
    [101, "edit", 250],
    [102, "message", undefined],
  ]);
  expect(records[2]).not.toHaveProperty("lagMs");
  expect(store.load()).toBe(104);
});

test("an edit Telegram dated no way records no lag instead of the message's age", async () => {
  const date = 1_700_000_000;
  const { http } = telegramFake([
    [{ update_id: 200, edited_message: { ...msg(OWNER, OWNER, "private", "edited"), date } }],
  ]);
  const path = join(state.dir, "telegram-lag.jsonl");
  const record = inboundLagLog(path);
  const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
  // Two hours after the original message: reporting that as receive lag would be a lie.
  await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (inbound) => record(inbound, (date + 7200) * 1000));
  const [entry] = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; lagMs?: number });
  expect(entry!.kind).toBe("edit");
  expect(entry).not.toHaveProperty("lagMs");
});
