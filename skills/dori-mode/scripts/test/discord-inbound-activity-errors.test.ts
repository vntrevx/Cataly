import { expect, test } from "bun:test";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

test("scope promotion preserves the activity failure instead of its follow-on cancellation", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  const timers = gatewayTimers();
  const socket = new FakeGateway("wss://gateway.discord.gg/");
  const backfill = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<string | undefined>();
  const failure = new Error("activity failed on scope admission");
  let known = false;
  let received = 0;
  let delivered = 0;
  const live = discordInboundLive(
    {
      sync: async (_emit, _queue, flushKnown) => {
        await backfill.promise;
        flushKnown?.();
      },
      accepts: (_message, parent) => parent === "20",
      cursorFor: () => "100",
      parentFor: () => (known ? "20" : undefined),
      needsThread: () => true,
      resolveThread: () => lookup.promise,
      adoptThread: () => "100",
      accept: async () => {
        delivered++;
      },
    },
    () => socket,
    "local-fixture-token",
    timers.clock,
    () => {},
    () => {},
    queue,
    {
      received: () => {
        if (++received === 2) throw failure;
      },
      healthy: () => {},
      unavailable: () => {},
    },
  );
  live.done.catch(() => {});
  try {
    socket.hello();
    socket.ready();
    await settle();
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("201", { channel_id: "50" }) });
    expect(received).toBe(1);
    known = true;
    backfill.resolve();
    await settle();
    lookup.resolve(undefined);
    await expect(live.done).rejects.toBe(failure);
    expect(delivered).toBe(0);
    expect(queue.first()?.kind).toBe("sync");
    expect(queue.nextChannel("0")).toBe("50");
    expect(socket.closed).toBe(true);
    expect(timers.pending.size).toBe(0);
  } finally {
    backfill.resolve();
    lookup.resolve(undefined);
    live.close();
    await live.done.catch(() => {});
    queue.close();
    state.done();
  }
});
