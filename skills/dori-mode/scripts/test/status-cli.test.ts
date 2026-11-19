import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

test("actual CLI shows JSON and text, then posts/edits the same board across subprocesses", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const registry = new Registry(stateDir);
    const lane = {
      key: "status-demo",
      title: "Demo",
      thread: "discord:40",
      openedAt: "2026-01-01T00:00:00Z",
      brief: "/brief",
      done: "file /done",
    };
    await registry.write(lane);
    const reports = new Reports(stateDir);
    reports.report(lane.key, "milestone", "First increment", Date.parse(lane.openedAt));
    const json = await f.invoke(["status", "--json"]);
    expect([json.code, json.err, json.keys]).toEqual([0, "", []]);
    expect(JSON.parse(json.out).lanes[0]).toMatchObject({ key: lane.key, runtime: null });
    const text = await f.invoke(["status", lane.key]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("First increment");
    expect(text.out).toContain("(read-only)");
    const args = ["board", "discord", "--thread", ids.thread, "--loop", "0"];
    const first = await f.invoke(args);
    expect([first.code, first.out, first.keys]).toEqual([
      0,
      "BOARD discord posted 50",
      [`POST /channels/${ids.thread}/messages`],
    ]);
    const same = await f.invoke(args);
    expect([same.code, same.out, same.keys]).toEqual([0, "BOARD discord unchanged 50", []]);
    reports.report(lane.key, "question", "Choose next", Date.parse(lane.openedAt) + 60_000);
    const changed = await f.invoke(args);
    expect([changed.code, changed.out, changed.keys]).toEqual([
      0,
      "BOARD discord edited 50",
      [`PATCH /channels/${ids.thread}/messages/50`],
    ]);
    expect(changed.requests[0]?.body?.["content"]).toContain("blocked");
    const eta = await f.invoke(["eta", "status-", "--json"]);
    expect(JSON.parse(eta.out)).toMatchObject({ samples: 0, medianMinutes: null });
  });
});

test.each(["status", "board", "eta"])(
  "actual %s CLI exposes incomplete registry without losing healthy data",
  async (command) => {
    await withDiscordCli(async (f) => {
      const registry = new Registry(dirname(f.tmp));
      const lane = {
        key: "healthy",
        title: "Healthy",
        thread: "discord:40",
        openedAt: "2026-01-01T00:00:00Z",
        brief: "brief",
        done: "file proof",
      };
      await registry.write(lane);
      for (let i = 0; i < 3; i++)
        await registry.write({ ...lane, key: `healthy-${i}`, closedAt: "2026-01-01T01:00:00Z" });
      writeFileSync(registry.path("damaged"), "{broken");
      const args =
        command === "board"
          ? [command, "discord", "--thread", ids.thread]
          : command === "eta"
            ? [command, "healthy", "--json"]
            : [command, "--json"];
      const result = await f.invoke(args);
      expect(result.code).toBe(0);
      if (command === "board") expect(result.requests[0]?.body?.["content"]).toContain("incomplete");
      else {
        const json = JSON.parse(result.out);
        expect(json.registryIncomplete).toBe(true);
        if (command === "eta") expect(json).toMatchObject({ samples: 3, medianMinutes: null });
        else expect(json.lanes.map((item: { key: string }) => item.key)).toEqual([lane.key]);
        expect(result.keys).toEqual([]);
      }
    });
  },
);

test("board CLI refuses malformed targets, recovery IDs and loops before any request", async () => {
  await withDiscordCli(async (f) => {
    for (const args of [
      ["eta", ""],
      ["board", "discord", "--to", ids.text, "--thread", ids.thread],
      ["board", "discord", "--thread", ""],
      ["board", "discord", "--to", "../else"],
      ["board", "discord", "--thread", ids.thread, "--message", ""],
      ["board", "discord", "--thread", ids.thread, "--loop", "5m"],
      ["board", "telegram", "--to", "-100", "--thread", "bad"],
      ["board", "telegram", "--to", "-100", "--message", "9007199254740992"],
    ]) {
      const result = await f.invoke(args);
      expect(result.code).toBe(1);
      expect(result.keys).toEqual([]);
    }
    const missing = await f.invoke(["status", "unknown"]);
    expect([missing.code, missing.err]).toEqual([1, "no registered lane unknown"]);
  });
});
