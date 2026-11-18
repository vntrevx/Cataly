import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoardTarget, updateBoard } from "../src/board.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

let state: { dir: string; done: () => void };
let requests: HttpRequest[];
let clock: ReturnType<typeof fakeClock>;
const target: BoardTarget = { platform: "discord", to: "40" };
let reply: { status: number; body: string };
const http: Http = async (request) => {
  requests.push(request);
  return { ...reply, headers: {} };
};
const options = () => ({ stateDir: state.dir, target, token: "synthetic", clock, body: "Dori status", http });
const recordPath = () =>
  join(state.dir, "boards", readdirSync(join(state.dir, "boards")).find((f) => f.endsWith(".json"))!);

beforeEach(() => {
  state = withState();
  requests = [];
  clock = fakeClock(Date.parse("2026-01-01T12:00:00Z"));
  reply = { status: 200, body: JSON.stringify({ id: "50" }) };
});
afterEach(() => state.done());

test("board posts once, reuses ID after restart and edits only changed content without mentions", async () => {
  expect(await updateBoard(options())).toEqual({ action: "posted", messageId: "50" });
  expect(requests).toHaveLength(1);
  await clock.sleep(60_000);
  expect(await updateBoard(options())).toEqual({ action: "unchanged", messageId: "50" });
  expect(requests).toHaveLength(1);
  expect(await updateBoard({ ...options(), body: "Changed @everyone" })).toEqual({ action: "edited", messageId: "50" });
  expect(requests[1]?.method).toBe("PATCH");
  expect(requests[1]?.url).toEndWith("/channels/40/messages/50");
  expect(JSON.parse(String(requests[1]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(JSON.parse(readFileSync(recordPath(), "utf8")).pending).toBe(false);
});

test("ambiguous create is recorded before network and never retried in-process or after restart", async () => {
  reply = { status: 503, body: "unavailable" };
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");
  expect(requests).toHaveLength(1);
  expect(JSON.parse(readFileSync(recordPath(), "utf8")).pending).toBe(true);
  reply = { status: 200, body: JSON.stringify({ id: "50" }) };
  await expect(updateBoard(options())).rejects.toThrow("inspect the destination");
  expect(requests).toHaveLength(1);
  expect(await updateBoard({ ...options(), messageId: "50" })).toEqual({ action: "edited", messageId: "50" });
  expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH"]);
});

test("lost transport, malformed reply and failed edit hold, never create a replacement", async () => {
  const fail: Http = async (request) => {
    requests.push(request);
    throw new Error("lost response");
  };
  await expect(updateBoard({ ...options(), http: fail })).rejects.toThrow("lost response");
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");
  await updateBoard({ ...options(), messageId: "50" });
  reply = { status: 404, body: JSON.stringify({ message: "Unknown Message" }) };
  await expect(updateBoard({ ...options(), body: "changed" })).rejects.toThrow("404");
  await expect(updateBoard({ ...options(), body: "changed" })).rejects.toThrow("unconfirmed");
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  await expect(updateBoard({ ...options(), messageId: "99" })).rejects.toThrow("does not match");
});

test("missing create ID cannot become a confirmed board", async () => {
  reply = { status: 200, body: "{}" };
  await expect(updateBoard(options())).rejects.toThrow("missing message ID");
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");
  expect(requests).toHaveLength(1);
});

test("a second writer cannot create while the first send is pending", async () => {
  const { promise: waiting, resolve: finish } = Promise.withResolvers<void>();
  const { promise: sending, resolve: reached } = Promise.withResolvers<void>();
  const first = updateBoard({
    ...options(),
    http: async (request) => {
      reached();
      await waiting;
      return http(request);
    },
  });
  await sending;
  await expect(updateBoard(options())).rejects.toThrow("another process");
  finish();
  await first;
  expect(requests).toHaveLength(1);
});

test("Telegram keeps chat/topic identity, one message and a persisted edit ID", async () => {
  reply = { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99 } }) };
  const tg = { ...options(), target: { platform: "telegram" as const, to: "-100", thread: 7 } };
  expect(await updateBoard(tg)).toEqual({ action: "posted", messageId: "99" });
  expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ chat_id: "-100", message_thread_id: 7 });
  await updateBoard({ ...tg, body: "new" });
  expect(requests[1]?.url).toEndWith("/editMessageText");
  expect(JSON.parse(String(requests[1]?.body)).message_id).toBe(99);
  expect(requests).toHaveLength(2);
});

test("damaged board records and oversized bodies cannot post", async () => {
  await expect(updateBoard({ ...options(), body: "x".repeat(2001) })).rejects.toThrow("one message");
  expect(requests).toHaveLength(0);
  await updateBoard(options());
  writeFileSync(recordPath(), "{broken");
  await expect(updateBoard(options())).rejects.toThrow("record unreadable");
  expect(requests).toHaveLength(1);
});
