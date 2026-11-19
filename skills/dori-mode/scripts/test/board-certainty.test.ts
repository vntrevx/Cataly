import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BoardError, type BoardTarget, updateBoard } from "../src/board.ts";
import type { Http } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const record = () => {
  const file = readdirSync(join(state.dir, "boards")).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("pending board record was removed");
  return JSON.parse(readFileSync(join(state.dir, "boards", file), "utf8"));
};

test.each(["discord", "telegram"] as const)(
  "uncertain HTTP 408 keeps the %s create fence across invocations",
  async (platform) => {
    const target: BoardTarget = platform === "discord" ? { platform, to: "40" } : { platform, to: "-100", thread: 7 };
    let calls = 0;
    let status = 408;
    const http: Http = async () => {
      calls++;
      return {
        status,
        headers: {},
        body:
          status === 408
            ? "request timeout"
            : JSON.stringify(platform === "discord" ? { id: "50" } : { ok: true, result: { message_id: 50 } }),
      };
    };
    const options = { stateDir: state.dir, target, token: "synthetic", clock: fakeClock(0), body: "status", http };
    const error = await updateBoard(options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(readdirSync(join(state.dir, "boards")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(record()).toMatchObject({ pending: true });
    expect(record()).not.toHaveProperty("messageId");
    expect(calls).toBe(1);
    status = 200;
    await expect(updateBoard(options)).rejects.toThrow("never auto-resend");
    expect(calls).toBe(1);
  },
);

test("board transport uncertainty keeps its recovery contract without exposing the original private error", async () => {
  let calls = 0;
  const error = await updateBoard({
    stateDir: state.dir,
    target: { platform: "discord", to: "40" },
    token: "synthetic",
    clock: fakeClock(0),
    body: "status",
    http: async () => {
      calls++;
      throw new Error("https://example.invalid/private?signature=synthetic-secret");
    },
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(BoardError);
  expect(String(error)).toContain("unconfirmed");
  expect(String(error)).toContain("lost response");
  expect(String(error)).not.toContain("synthetic-secret");
  expect(record()).toMatchObject({ pending: true });
  expect(calls).toBe(1);
});

test.each([{}, { id: "51" }, { id: 50 }, null].map((reply) => ({ reply })))(
  "a Discord edit cannot confirm a missing or different message receipt: %p",
  async ({ reply }) => {
    let calls = 0;
    const http: Http = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(++calls === 1 ? { id: "50" } : reply),
    });
    const options = {
      stateDir: state.dir,
      target: { platform: "discord" as const, to: "40" },
      token: "synthetic",
      clock: fakeClock(0),
      body: "status",
      http,
    };
    await updateBoard(options);
    await expect(updateBoard({ ...options, body: "changed" })).rejects.toThrow("unconfirmed");
    expect(record()).toMatchObject({ pending: true, messageId: "50" });
    await expect(updateBoard({ ...options, body: "changed" })).rejects.toThrow("never auto-resend");
    expect(calls).toBe(2);
  },
);
