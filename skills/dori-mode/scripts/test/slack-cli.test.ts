import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { type TestState, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "record-fetch.ts");
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

// The real CLI against a recorded fetch: Slack methods answer from `replies`, every request is logged.
const slackCli = async (args: readonly string[], replies: Record<string, unknown> = {}, retryAfter?: number) => {
  const config = join(state.dir, "config.json");
  const log = join(state.dir, "fetch.jsonl");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  rmSync(log, { force: true });
  const r = await run(
    [
      "env",
      `DORI_CONFIG=${config}`,
      `DORI_STATE_DIR=${state.dir}`,
      "DORI_SLACK_TOKEN=xoxb-not-a-real-token",
      `DORI_TEST_FETCH_LOG=${log}`,
      `DORI_TEST_FETCH_REPLIES=${JSON.stringify(replies)}`,
      ...(retryAfter === undefined ? [] : [`DORI_TEST_SLACK_RETRY_AFTER=${retryAfter}`]),
      process.execPath,
      "--preload",
      recorder,
      cli,
      ...args,
    ],
    { timeoutMs: 20_000 },
  );
  const methods = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { url: string }).url.split("/").at(-1))
    : [];
  return { ...r, methods };
};

test("Slack inbound prints the owner's whole message on its one INBOUND line", async () => {
  const text = `${"x".repeat(240)}\nthen "quoted" and DO_NOT_DEPLOY`;
  const r = await slackCli(["inbound", "slack", "--loop", "0"], {
    "auth.test": { ok: true, user_id: "U_SELF" },
    "subscriptions.thread.getView": {
      ok: true,
      threads: [
        { root_msg: { channel: "C1" }, unread_replies: [{ ts: "11.1", thread_ts: "10.1", user: "U_OWNER", text }] },
      ],
    },
    "conversations.replies": { ok: true, messages: [] },
    "client.counts": { ok: true, channels: [], ims: [], mpims: [] },
  });
  expect([r.code, r.err]).toEqual([0, ""]);
  expect(r.out.split("\n")).toEqual([
    "INBOUND_READY slack",
    `INBOUND threads-view C1 10.1 11.1 U_OWNER ${JSON.stringify(text)}`,
  ]);
});

test.each([8, 3_600])("Slack honors a %is Retry-After floor or exits when it exceeds budget", async (seconds) => {
  const result = await slackCli(
    ["inbound", "slack", "--loop", "0.05"],
    {
      "auth.test": { ok: true, user_id: "U_SELF" },
      "subscriptions.thread.getView": { ok: true, threads: [] },
      "client.counts": { ok: true, ims: [{ id: "D1", has_unreads: true }] },
    },
    seconds,
  );
  const waits = result.out.split("\n").filter((line) => line.startsWith("FETCH_SLEEP "));
  expect(result.out).toContain("INBOUND_READY slack");
  if (seconds === 3_600) {
    expect(result.code).toBe(1);
    expect(result.err).toContain("HTTP 429; Retry-After exceeds the 60s automatic retry limit");
    expect(result.methods).toEqual(["auth.test", "subscriptions.thread.getView"]);
    expect(waits).toEqual([]);
  } else {
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(waits).toEqual([...Array(5).fill("FETCH_SLEEP 8000"), "FETCH_SLEEP 3000"]);
    expect(result.methods).toEqual(["auth.test", ...Array(6).fill("subscriptions.thread.getView"), "client.counts"]);
    expect(result.out).toContain('INBOUND unread D1 - - - "0 mention(s), unread"');
  }
});

test("send slack refuses an --edit that is empty or not a message ts before it posts anything", async () => {
  const send = (...flags: string[]) => slackCli(["send", "slack", "--to", "C1", "--text", "report", ...flags]);
  for (const flags of [["--edit", ""], ["--edit", " "], ["--edit"], ["--edit", "last"]]) {
    const r = await send(...flags);
    expect({ flags, code: r.code, err: r.err, out: r.out, methods: r.methods }).toEqual({
      flags,
      code: 1,
      err: "--edit must be a Slack message ts, such as 1700000000.000100",
      out: "",
      methods: [],
    });
  }
  const edited = await send("--edit", "1700000000.000100");
  expect([edited.code, edited.out, edited.methods]).toEqual([0, "", ["chat.update"]]);
});
