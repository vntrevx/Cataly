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
const slackCli = async (args: readonly string[], replies: Record<string, unknown> = {}) => {
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
      `DORI_TEST_FETCH_REPLIES=${JSON.stringify({ "auth.test": { ok: true, team_id: "T_TEST", user_id: "U_SELF" }, ...replies })}`,
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
    "auth.test": { ok: true, team_id: "T_TEST", user_id: "U_SELF" },
    "subscriptions.thread.getView": {
      ok: true,
      threads: [
        {
          root_msg: { channel: "C1", ts: "10.1" },
          unread_replies: [{ ts: "11.1", thread_ts: "10.1", user: "U_OWNER", text }],
        },
      ],
    },
    "conversations.replies": { ok: true, messages: [] },
    "client.counts": { ok: true, channels: [], ims: [], mpims: [] },
  });
  expect([r.code, r.err]).toEqual([0, ""]);
  expect(r.out.split("\n")).toEqual([
    "INBOUND_READY slack workspace=T_TEST account=U_SELF",
    `INBOUND threads-view slack:T_TEST:U_SELF:C1 10.1 11.1 U_OWNER ${JSON.stringify(text)}`,
  ]);
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

test("an inbound Slack destination round-trips only through its authenticated account", async () => {
  const target = "slack:T_TEST:U_SELF:C1";
  const sent = await slackCli(["send", "slack", "--to", target, "--thread", "10.1", "--text", "reply"], {
    "chat.postMessage": { ok: true, channel: "C1", ts: "12.1" },
  });
  expect([sent.code, sent.err, sent.out, sent.methods]).toEqual([
    0,
    "",
    "SENT 12.1",
    ["auth.test", "chat.postMessage"],
  ]);
  const requests = readFileSync(join(state.dir, "fetch.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests[1].body).toEqual({ channel: "C1", text: "reply", thread_ts: "10.1" });
  const original = readFileSync(join(state.dir, "slack-threads.json"), "utf8");
  for (const wrong of ["slack:T_OTHER:U_SELF:C1", "slack:T_TEST:U_OTHER:C1"]) {
    for (const flags of [[], ["--edit", "12.1"]]) {
      const denied = await slackCli(["send", "slack", "--to", wrong, "--text", "reply", ...flags]);
      expect([denied.code, denied.out, denied.methods]).toEqual([1, "", ["auth.test"]]);
      expect(denied.err).toContain("different authenticated workspace or account");
      expect(readFileSync(join(state.dir, "slack-threads.json"), "utf8")).toBe(original);
    }
  }
});

test("legacy Slack records refuse inbound and new posts until an explicit matching adoption", async () => {
  const file = join(state.dir, "slack-threads.json");
  const legacy = JSON.stringify([{ channel: "C1", rootTs: "10.1", seenTs: "11.1" }]);
  writeFileSync(file, legacy);
  for (const args of [
    ["inbound", "slack", "--loop", "0"],
    ["send", "slack", "--to", "C1", "--text", "reply"],
  ]) {
    const held = await slackCli(args);
    expect([held.code, held.out, held.methods]).toEqual([1, "", ["auth.test"]]);
    expect(held.err).toContain("unscoped Slack threads");
    expect(readFileSync(file, "utf8")).toBe(legacy);
  }
  const wrong = await slackCli(["inbound", "slack", "--loop", "0", "--adopt-legacy-threads", "T_OTHER:U_SELF"]);
  expect([wrong.code, wrong.out, wrong.methods]).toEqual([1, "", ["auth.test"]]);
  expect(wrong.err).toContain("does not match");
  expect(readFileSync(file, "utf8")).toBe(legacy);
  const args = ["inbound", "slack", "--loop", "0", "--adopt-legacy-threads", "T_TEST:U_SELF"];
  const adopted = await slackCli(args, {
    "subscriptions.thread.getView": { ok: true, threads: [] },
    "conversations.replies": {
      ok: true,
      messages: [{ ts: "12.1", thread_ts: "10.1", user: "U_GUEST", text: "hello" }],
    },
    "client.counts": { ok: true, channels: [], ims: [], mpims: [] },
  });
  expect([adopted.code, adopted.err]).toEqual([0, ""]);
  const lines = adopted.out.split("\n");
  const receipt = JSON.parse(String(lines[0]).replace("SLACK_THREADS_ADOPTED ", ""));
  expect(receipt).toMatchObject({ scope: { teamId: "T_TEST", userId: "U_SELF" }, count: 1 });
  expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
  expect(lines.slice(1)).toEqual([
    "INBOUND_READY slack workspace=T_TEST account=U_SELF",
    'INBOUND own-thread slack:T_TEST:U_SELF:C1 10.1 12.1 U_GUEST "hello"',
  ]);
  const recorded = readFileSync(join(state.dir, "fetch.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(recorded.find((r) => r.url.endsWith("conversations.replies")).body.oldest).toBe("11.1");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.threads).toEqual([{ channel: "C1", rootTs: "10.1", seenTs: "12.1", scope: receipt.scope }]);
  expect(saved.adopted).toEqual(receipt);
  const repeated = await slackCli(args);
  expect([repeated.code, repeated.err, repeated.out.split("\n")[0]]).toEqual([0, "", lines[0]]);
  expect(JSON.parse(readFileSync(file, "utf8")).adopted).toEqual(receipt);
});

test("malformed or non-Slack adoption arguments make no request", async () => {
  for (const args of [
    ["inbound", "slack", "--adopt-legacy-threads", "T_TEST"],
    ["inbound", "slack", "--adopt-legacy-threads", "T_TEST:U_SELF:extra"],
    ["inbound", "slack", "--adopt-legacy-threads", "T_TEST:U_SELF", "--adopt-legacy-threads", "T_TEST:U_SELF"],
    ["inbound", "telegram", "--adopt-legacy-threads", "T_TEST:U_SELF"],
  ]) {
    const r = await slackCli(args);
    expect([r.code, r.out, r.methods]).toEqual([1, "", []]);
    expect(existsSync(join(state.dir, "slack-threads.json"))).toBe(false);
  }
});
