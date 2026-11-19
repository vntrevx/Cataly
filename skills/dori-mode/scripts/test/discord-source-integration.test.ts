import { expect, spyOn, test } from "bun:test";
import { Discord, isThreadType } from "../src/messenger/discord.ts";
import { discordApiBase } from "../src/messenger/discord-api-base.ts";
import { markDiscordInboundSeen } from "../src/messenger/discord-inbound.ts";
import { discordInboundOptions } from "../src/messenger/discord-inbound-env.ts";
import { DeliveryUncertainError, type HttpRequest, MessengerError } from "../src/messenger/http.ts";

const scope = () =>
  discordInboundOptions({
    DORI_DISCORD_OWNER_ID: "10",
    DORI_DISCORD_CHANNEL_ID: "20, 20",
    DORI_DISCORD_CHANNEL_IDS: "30,20",
  });
const noWait = {
  now: () => 0,
  sleep: async () => {
    throw new Error("unexpected retry");
  },
};

test("shared source settings retain cancellable single-attempt metadata and the dedicated API base", async () => {
  const options = scope();
  expect(options).toEqual({ ownerId: "10", channelIds: ["20", "30"], all: false, threads: true });
  expect([0, 4, 10, 11, 12, 15, 16].map(isThreadType)).toEqual([false, false, true, true, true, false, false]);
  const calls: HttpRequest[] = [];
  const dc = new Discord(
    async (request) => {
      calls.push(request);
      return { status: 500, body: "{}", headers: {} };
    },
    noWait,
    "synthetic-token",
    discordApiBase("http://127.0.0.1:9876/api/v10"),
  );
  const signal = new AbortController().signal;
  const outcome = await dc
    .call("GET", `/channels/${options.channelIds[0]}`, undefined, signal)
    .catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(MessengerError);
  expect(outcome).toMatchObject({ status: 500 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "GET", url: "http://127.0.0.1:9876/api/v10/channels/20", signal });
});

test("source parent support does not turn a canceled create candidate into a confirmed receipt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const dc = new Discord(
    async () => {
      calls++;
      controller.abort(new Error("owned source operation stopped"));
      return {
        status: 200,
        body: JSON.stringify({ id: "40", type: 11, parent_id: scope().channelIds[0] }),
        headers: {},
      };
    },
    noWait,
    "synthetic-token",
  );
  const outcome = await dc
    .call("POST", "/channels/20/threads", { name: "task", type: 11 }, controller.signal)
    .catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(DeliveryUncertainError);
  expect(outcome).toMatchObject({ outcome: "uncertain", candidateReceipt: { id: "40" } });
  expect(outcome).toMatchObject({ receipt: undefined });
  expect(calls).toBe(1);
});

for (const status of [204, 503]) {
  test(`shared source modules preserve non-replaying lane read receipts: ${status}`, async () => {
    const calls: HttpRequest[] = [];
    let sleeps = 0;
    const dc = new Discord(
      async (request) => {
        calls.push(request);
        return { status, body: status === 204 ? "" : "{}", headers: {} };
      },
      {
        now: () => 0,
        sleep: async () => {
          sleeps++;
        },
      },
      "synthetic-token",
    );
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await markDiscordInboundSeen(dc, { channel: scope().channelIds[0]!, message: "101" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PUT");
      expect(new URL(calls[0]!.url).pathname).toBe("/api/v10/channels/20/messages/101/reactions/%F0%9F%91%80/@me");
      expect(sleeps).toBe(0);
      if (status === 503) expect(log.mock.calls).toEqual([["Discord read receipt failed for 20/101"]]);
      else expect(log.mock.calls).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
}

for (const method of ["GET", "POST"] as const) {
  test(`wake error codes survive source-aware Discord ${method} rejection`, async () => {
    let calls = 0;
    const dc = new Discord(
      async () => {
        calls++;
        return { status: 404, body: JSON.stringify({ code: 10008, message: "Unknown Message" }), headers: {} };
      },
      noWait,
      "synthetic-token",
    );
    const outcome = await (method === "GET"
      ? dc.call("GET", "/channels/20/messages/101")
      : dc.startThread("20", "101", "task")
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(MessengerError);
    expect(outcome).toMatchObject({ status: 404, code: "10008", outcome: "rejected" });
    expect(calls).toBe(1);
  });

  test(`wake error decoding retains ${method} malformed-success semantics`, async () => {
    let calls = 0;
    const dc = new Discord(
      async () => {
        calls++;
        return { status: 200, body: "{", headers: {} };
      },
      noWait,
      "synthetic-token",
    );
    const outcome = await (method === "GET"
      ? dc.call("GET", "/channels/20/messages/101")
      : dc.startThread("20", "101", "task")
    ).catch((error: unknown) => error);
    if (method === "GET") expect(outcome).toBeInstanceOf(SyntaxError);
    else {
      expect(outcome).toBeInstanceOf(DeliveryUncertainError);
      expect(outcome).toMatchObject({ status: 200, outcome: "uncertain", receipt: undefined });
    }
    expect(calls).toBe(1);
  });
}

test("wake error codes do not replace a rejected source mutation cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new Error("source mutation canceled");
  let calls = 0;
  const dc = new Discord(
    async () => {
      calls++;
      controller.abort(reason);
      return { status: 404, body: JSON.stringify({ code: 10008 }), headers: {} };
    },
    noWait,
    "synthetic-token",
  );
  const outcome = await dc
    .call("POST", "/channels/20/threads", { name: "task", type: 11 }, controller.signal)
    .catch((error: unknown) => error);
  expect(outcome).toBe(reason);
  expect(calls).toBe(1);
});
