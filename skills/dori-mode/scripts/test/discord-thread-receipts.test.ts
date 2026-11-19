import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { DiscordThreadReceipts, type ThreadAttempt } from "../src/messenger/discord-thread-receipts.ts";
import { withState } from "./fakes.ts";

const confirmed: ThreadAttempt = {
  kind: "create",
  source: { botId: "99", ownerId: "7", channelId: "30", messageId: "35" },
  lane: "source-task",
  parent: "30",
  fingerprint: createHash("sha256").update("create 30 task").digest("hex"),
  at: 1,
  state: "confirmed",
  thread: "40",
  message: "51",
};

test("thread receipts round-trip privately and reads leave their exact bytes untouched", () => {
  const state = withState();
  try {
    const store = new DiscordThreadReceipts(state.dir);
    expect(store.read()).toEqual([]);
    store.write([confirmed]);
    const bytes = readFileSync(store.path, "utf8");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(store.read()).toEqual([confirmed]);
    expect(readFileSync(store.path, "utf8")).toBe(bytes);
  } finally {
    state.done();
  }
});

const corrupt: readonly (readonly unknown[])[] = [
  [{ ...confirmed, state: ["confirmed"] }],
  [{ ...confirmed, source: { ...confirmed.source, botId: 99 } }],
  [{ ...confirmed, parent: "forum" }],
  [{ ...confirmed, state: "pending" }],
  [{ ...confirmed, candidate: "41" }],
  [{ ...confirmed, extra: true }],
  [confirmed, { ...confirmed, lane: "other-task", source: { ...confirmed.source, botId: "100" } }],
  [confirmed, { ...confirmed, source: { ...confirmed.source, messageId: "36" }, thread: "42" }],
  [confirmed, { ...confirmed, lane: "other-task", source: { ...confirmed.source, messageId: "36" } }],
];
for (const [index, attempts] of corrupt.entries())
  test(`invalid or conflicting receipt state ${index} is refused without overwriting evidence`, () => {
    const state = withState();
    try {
      const store = new DiscordThreadReceipts(state.dir);
      const bytes = JSON.stringify({ version: 1, attempts });
      writeFileSync(store.path, bytes, { mode: 0o600 });
      expect(() => store.read()).toThrow("receipt state is unreadable");
      expect(readFileSync(store.path, "utf8")).toBe(bytes);
    } finally {
      state.done();
    }
  });
