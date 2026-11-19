import { expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { makeCli } from "../src/cli-context.ts";
import { sourceThreadDiscord } from "../src/cli-discord-thread-source.ts";
import { DiscordThreadReceipts } from "../src/messenger/discord-thread-receipts.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const mockTransport = (run: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(run, {
      preconnect: () => {
        throw new Error("unexpected isolated preconnect");
      },
    }),
  );

const fixture = () => {
  const state = withState();
  const deps = depsFor(newWorld(), fakeClock(1), state.dir);
  const cli = makeCli(
    "thread",
    [],
    {
      positionals: ["discord", "create"],
      values: { to: "30", title: "task", text: "starter", source: "discord 30 35", lane: "source-task" },
    },
    deps.config,
    deps,
  );
  const environment = {
    DORI_DISCORD_TOKEN: "synthetic",
    DORI_DISCORD_OWNER_ID: "7",
    DORI_DISCORD_CHANNEL_ID: "30",
    DORI_DISCORD_CHANNEL_IDS: undefined,
    DORI_DISCORD_SCOPE: undefined,
    DORI_DISCORD_API_BASE: undefined,
  };
  const before = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const reads: Record<string, unknown> = {
    "/users/@me": { id: "99" },
    "/channels/30": { id: "30", type: 0 },
    "/channels/30/messages/35": { id: "35", channel_id: "30", type: 0, author: { id: "7" } },
  };
  return {
    cli,
    store: new DiscordThreadReceipts(state.dir),
    reads,
    done: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      state.done();
    },
  };
};
const created = { id: "40", type: 11, parent_id: "30", owner_id: "99" };

test("write-ahead precedes HTTP, a live competing writer fails closed, and creation precedes its starter", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mutations: string[] = [];
  const log = spyOn(console, "log").mockImplementation(() => {});
  const transport = mockTransport(async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    if (init?.method === "GET" && path in f.reads) return Response.json(f.reads[path]);
    if (init?.method === "POST" && path === "/channels/30/threads") {
      mutations.push(path);
      expect(f.store.read()[0]?.state).toBe("pending");
      expect(statSync(f.store.path).mode & 0o777).toBe(0o600);
      entered.resolve();
      await release.promise;
      return Response.json(created);
    }
    if (init?.method === "POST" && path === "/channels/40/messages") {
      mutations.push(path);
      expect(f.store.read()[0]).toMatchObject({ state: "created", thread: "40" });
      return Response.json({ id: "51" });
    }
    throw new Error(`unexpected isolated HTTP request: ${init?.method} ${path}`);
  });
  const first = sourceThreadDiscord(f.cli);
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("creation escaped its response gate");
      }),
    ]);
    const pending = readFileSync(f.store.path, "utf8");
    await expect(sourceThreadDiscord(f.cli)).rejects.toThrow("receipt lock");
    expect(readFileSync(f.store.path, "utf8")).toBe(pending);
    expect(mutations).toEqual(["/channels/30/threads"]);
    release.resolve();
    await first;
    expect(mutations).toEqual(["/channels/30/threads", "/channels/40/messages"]);
    expect(f.store.read()[0]).toMatchObject({ state: "confirmed", thread: "40", message: "51" });
    expect(log.mock.calls).toEqual([["THREAD 40 mid=51"]]);
  } finally {
    release.resolve();
    await first.catch(() => {});
    transport.mockRestore();
    log.mockRestore();
    f.done();
  }
});

for (const failAt of [2, 3])
  test(`receipt write ${failAt} failure reports the known thread and keeps the durable fence`, async () => {
    const f = fixture();
    let mutations = 0;
    let writes = 0;
    const original = DiscordThreadReceipts.prototype.write;
    const persistence = spyOn(DiscordThreadReceipts.prototype, "write").mockImplementation(function (
      this: DiscordThreadReceipts,
      attempts,
    ) {
      if (++writes === failAt) throw new Error("synthetic fsync failure");
      return original.call(this, attempts);
    });
    const transport = mockTransport(async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/api/v10", "");
      if (init?.method === "GET" && path in f.reads) return Response.json(f.reads[path]);
      if (init?.method === "POST" && path === "/channels/30/threads") {
        mutations++;
        return Response.json(created);
      }
      if (init?.method === "POST" && path === "/channels/40/messages") {
        mutations++;
        return Response.json({ id: "51" });
      }
      throw new Error(`unexpected isolated HTTP request: ${init?.method} ${path}`);
    });
    try {
      const error = await sourceThreadDiscord(f.cli).catch((value: unknown) => value);
      expect(String(error)).toContain("thread 40 exists");
      expect(error).toMatchObject({ outcome: "uncertain" });
      expect(f.store.read()[0]?.state).toBe(failAt === 2 ? "pending" : "created");
      expect(mutations).toBe(failAt - 1);
      await expect(sourceThreadDiscord(f.cli)).rejects.toThrow("held");
      expect(mutations).toBe(failAt - 1);
      expect(writes).toBe(failAt);
    } finally {
      transport.mockRestore();
      persistence.mockRestore();
      f.done();
    }
  });
