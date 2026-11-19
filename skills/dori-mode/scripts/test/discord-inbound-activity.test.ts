import { afterEach, expect, test } from "bun:test";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(
  sync: () => Promise<void>,
  options: {
    failHealth?: boolean;
    failReceive?: boolean;
    failUnavailable?: boolean;
    openFailures?: number;
    deliver?: () => Promise<void>;
    retained?: boolean;
    intake?: Partial<Parameters<typeof discordInboundLive>[0]>;
  } = {},
) {
  let openFailures = options.openFailures ?? 0;
  const timers = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const observed: string[] = [];
  const health: boolean[] = [];
  let delivered = 0;
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  if (options.retained) queue.push("message", ownerMessage("101"), "100");
  const live = discordInboundLive(
    {
      sync,
      accepts: () => true,
      cursorFor: () => "100",
      accept: async () => {
        await options.deliver?.();
        delivered++;
      },
      ...options.intake,
    },
    (url) => {
      if (openFailures-- > 0) throw new Error("local connect failure");
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "local-fixture-token",
    timers.clock,
    () => {},
    () => {},
    queue,
    {
      received: (message) => {
        if (options.failReceive) throw new Error("activity receive failed");
        observed.push(message.id);
      },
      healthy: () => {
        if (options.failHealth) throw new Error("activity write failed");
        health.push(true);
      },
      unavailable: () => {
        if (options.failUnavailable) throw new Error("activity unavailable write failed");
        health.push(false);
      },
    },
  );
  live.done.catch(() => {});
  cleanups.push(async () => {
    live.close();
    await live.done.catch(() => {});
    queue.close();
    state.done();
  });
  return { live, timers, sockets, health, observed, queue, delivered: () => delivered };
}

test("Gateway activity is seen before queued delivery; health waits for complete backfill", async () => {
  const backfill = Promise.withResolvers<void>();
  const f = setup(() => backfill.promise);
  const socket = f.sockets[0]!;
  try {
    socket.hello(1000);
    socket.ready();
    await settle();
    f.timers.advance(500);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false]);
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("101") });
    expect(f.observed).toEqual(["101"]);
    expect(f.delivered()).toBe(0);
    backfill.resolve();
    await settle();
    expect(f.health).toEqual([false, true]);
    expect(f.delivered()).toBe(1);
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false, true, true, true]);
    socket.disconnect(1006);
    expect(f.health.at(-1)).toBe(false);
  } finally {
    backfill.resolve();
    f.live.close();
    await f.live.done;
  }
});

test("a backfill finishing after disconnect cannot certify the dead connection as healthy", async () => {
  const backfill = Promise.withResolvers<void>();
  const f = setup(() => backfill.promise);
  try {
    const socket = f.sockets[0]!;
    socket.hello();
    socket.ready();
    await settle();
    socket.disconnect(1006);
    backfill.resolve();
    await settle();
    expect(f.health.every((value) => value === false)).toBe(true);
  } finally {
    backfill.resolve();
    f.live.close();
    await f.live.done;
  }
});

test("a failed activity writer stops intake and preserves the undelivered queue", async () => {
  const f = setup(async () => {}, { failHealth: true });
  const socket = f.sockets[0]!;
  socket.hello();
  socket.ready();
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("101") });
  await expect(f.live.done).rejects.toThrow("activity write failed");
  expect(f.delivered()).toBe(0);
  expect(socket.closed).toBe(true);
  expect(f.timers.pending.size).toBe(0);
});

test("heartbeat ACKs cannot refresh health while durable delivery is blocked", async () => {
  const delivery = Promise.withResolvers<void>();
  const f = setup(async () => {}, { deliver: () => delivery.promise });
  const socket = f.sockets[0]!;
  try {
    socket.hello(1000);
    socket.ready();
    await settle();
    expect(f.health).toEqual([false, true]);
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("101") });
    f.timers.advance(500);
    socket.receive({ op: 11 });
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false, true]);
    expect(f.queue.first()?.kind).toBe("message");
    delivery.resolve();
    await settle();
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false, true, true]);
    expect(f.delivered()).toBe(1);
    expect(f.queue.first()).toBeNull();
  } finally {
    delivery.resolve();
  }
});

test("an activity receipt failure retains the accepted Gateway frame before stopping", async () => {
  const f = setup(async () => {}, { failReceive: true });
  const socket = f.sockets[0]!;
  socket.hello();
  socket.ready();
  await settle();
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("101") });
  await expect(f.live.done).rejects.toThrow("activity receive failed");
  expect(f.delivered()).toBe(0);
  expect(JSON.parse(f.queue.first()!.payload).id).toBe("101");
  expect(socket.closed).toBe(true);
});

test("retained offline recovery cannot certify a newer connection before its backfill", async () => {
  const old = Promise.withResolvers<void>();
  const fresh = Promise.withResolvers<void>();
  let reads = 0;
  const f = setup(() => (reads++ === 0 ? old.promise : fresh.promise), { retained: true });
  try {
    const socket = f.sockets[0]!;
    socket.hello();
    socket.ready();
    old.resolve();
    await settle();
    expect(reads).toBe(2);
    expect(f.health).toEqual([false]);
    fresh.resolve();
    await settle();
    expect(f.health).toEqual([false, true]);
    expect(f.delivered()).toBe(1);
  } finally {
    old.resolve();
    fresh.resolve();
  }
});

test("a volatile thread candidate is owner activity and blocks health until its scope is admitted", async () => {
  const lookup = Promise.withResolvers<string | undefined>();
  const intake: Partial<Parameters<typeof discordInboundLive>[0]> = {
    accepts: (message, parent) => message.channel_id === "20" || parent === "20",
    needsThread: (message) => message.channel_id === "50",
    resolveThread: () => lookup.promise,
    adoptThread: () => "100",
  };
  const f = setup(async () => {}, { intake });
  const socket = f.sockets[0]!;
  try {
    socket.hello(1000);
    socket.ready();
    await settle();
    expect(f.health).toEqual([false, true]);
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("201", { channel_id: "50" }) });
    expect(f.observed).toEqual(["201"]);
    expect(f.queue.first()).toBeNull();
    f.timers.advance(500);
    socket.receive({ op: 11 });
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false, true]);
    lookup.resolve("20");
    await settle();
    expect(f.observed).toEqual(["201", "201"]);
    expect(f.delivered()).toBe(1);
    f.timers.advance(1000);
    socket.receive({ op: 11 });
    expect(f.health).toEqual([false, true, true]);
  } finally {
    lookup.resolve(undefined);
  }
});

test("an activity failure in a synchronous connect failure stops intake before the Gateway exists", async () => {
  const f = setup(async () => {}, { failUnavailable: true, openFailures: 1 });
  await expect(f.live.done).rejects.toThrow("activity unavailable write failed");
  expect(f.sockets).toHaveLength(0);
  expect(f.timers.pending.size).toBe(0);
});
