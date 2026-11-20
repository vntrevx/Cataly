import { expect, test } from "bun:test";
import { linkSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the real cursor checks ownership, mode bits and filesystem link identity.
const posix = test.skipIf(process.platform === "win32");

const saved = { offset: 1001, observedAt: 1000, seen: ["a".repeat(64)] };
posix("invalid observation metadata preserves valid delivery receipts without trusting the offset epoch", () => {
  const state = withState();
  try {
    const store = fileTgInboundStore(state.dir, 900);
    const path = join(state.dir, "telegram-inbound", "900.json");
    for (const observedAt of [undefined, null, "1000", -1, 1.5]) {
      writeFileSync(path, JSON.stringify({ version: 1, botId: 900, ...saved, observedAt }), { mode: 0o600 });
      expect(store.load()).toEqual({ offset: 1001, seen: saved.seen });
    }
    store.save(saved);
    expect(store.load()).toEqual(saved);
    expect(readdirSync(join(state.dir, "telegram-inbound"))).toEqual(["900.json"]);
  } finally {
    state.done();
  }
});

posix("a valid state file bound to another bot fails closed and is not overwritten", () => {
  const state = withState();
  try {
    const store = fileTgInboundStore(state.dir, 900);
    const path = join(state.dir, "telegram-inbound", "900.json");
    const bytes = JSON.stringify({ version: 1, botId: 901, ...saved });
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() => store.load()).toThrow("belongs to a different bot");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    for (const bot of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => fileTgInboundStore(state.dir, bot)).toThrow("bot ID is invalid");
  } finally {
    state.done();
  }
});

posix("linked Telegram cursor files are rejected before read or replacement", () => {
  const state = withState();
  try {
    const store = fileTgInboundStore(state.dir, 900);
    const path = join(state.dir, "telegram-inbound", "900.json");
    const canary = join(state.dir, "canary.json");
    const bytes = JSON.stringify({ version: 1, botId: 900, ...saved });
    writeFileSync(canary, bytes, { mode: 0o600 });
    for (const link of [symlinkSync, linkSync]) {
      link(canary, path);
      expect(() => store.load()).toThrow();
      expect(() => store.save(saved)).toThrow();
      expect(readFileSync(canary, "utf8")).toBe(bytes);
      unlinkSync(path);
    }
  } finally {
    state.done();
  }
});
