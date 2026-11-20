import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Playback } from "../src/voice/audio.ts";
import { liveSocket, parseLiveEvent } from "../src/voice/provider.ts";
import { Replies } from "../src/voice/replies.ts";
import { VoiceSession } from "../src/voice/session.ts";
import type { Wire } from "../src/voice/types.ts";
import { LiveMeter, VoiceUsage } from "../src/voice/usage.ts";
import { settings, temporaryVoice } from "./voice-fixture.ts";

type Ledger = {
  days: Record<string, { liveSeconds: number; pausedSeconds: number; sessions: number; backendUsd: number }>;
};
const ledger = (directory: string): Ledger => JSON.parse(readFileSync(join(directory, "usage.json"), "utf8"));

/** A loopback stand-in for the Live primary WebSocket; no OpenAI endpoint or key is used. */
const loopback = (afterStart: Wire[], closedUsage: Wire) => {
  const temp = temporaryVoice();
  const received: Wire[] = [];
  const headers: { authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      headers.authorization = request.headers.get("authorization");
      return srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const event: Wire = JSON.parse(String(data));
        received.push(event);
        if (event["type"] === "session.start") {
          ws.send(JSON.stringify({ type: "session.started", session: { id: "live_loopback" } }));
          for (const next of afterStart) ws.send(JSON.stringify(next));
        }
        if (event["type"] === "session.close") {
          ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: closedUsage }));
          ws.close();
        }
      },
    },
  });
  const config = settings({ liveModel: "gpt-live-1.1", voice: "marin", dailyMinuteCap: 0.3 });
  const started = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const logs: string[] = [];
  const usage = new (class extends VoiceUsage {
    override live(key: string, seconds: number, split?: ReadonlyMap<string, number>): void {
      super.live(key, seconds, split);
      if (split?.size) paused.resolve();
    }
  })(temp.directory, config, () => 1000);
  const session = new VoiceSession(
    config,
    {
      now: () => 1000,
      key: "synthetic-no-paid-key",
      open: liveSocket(`ws://127.0.0.1:${server.port}/v1/live/sessions`),
      playback: new Playback(),
      replies: new Replies(temp.directory, () => {}),
      usage,
      tool: async () => ({ ok: true, result: "unused" }),
      log: (line) => logs.push(line),
      started: () => started.resolve(),
      finished: async () => {},
    },
    false,
  );
  session.open();
  return {
    temp,
    received,
    headers,
    usage,
    session,
    logs,
    started: started.promise,
    paused: paused.promise,
    cleanup: async () => {
      if (session.state !== "closed") session.close("shutdown");
      await session.done;
      server.stop(true);
      temp.cleanup();
    },
  };
};

test("gpt-live-1.1 over a loopback Live socket records billed and paused seconds from the usage breakdown", async () => {
  const w = loopback(
    [
      { type: "session.usage.updated", usage: { seconds: 12, active_seconds: 12 } },
      {
        type: "session.usage.updated",
        usage: { seconds: 15, active_seconds: 11, paused_seconds: 4 },
        context_window: { usage_ratio: 0.1 },
      },
    ],
    { seconds: 20, active_seconds: 14, paused_seconds: 6 },
  );
  try {
    await w.started;
    expect(w.received[0]).toMatchObject({
      type: "session.start",
      session: {
        model: "gpt-live-1.1",
        audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "marin" } },
      },
    });
    expect(Object.keys(w.received[0]!["session"] as object)).not.toContain("wake_policy");
    expect(w.headers.authorization).toBe("Bearer synthetic-no-paid-key");
    await w.paused;
    // Cumulative usage is recorded once, not added per update.
    expect(Object.values(ledger(w.temp.directory).days)).toEqual([
      { liveSeconds: 15, pausedSeconds: 4, sessions: 1, backendUsd: 0 },
    ]);
    w.session.close("shutdown");
    await w.session.done;
    expect(w.session.failed).toBe(false);
    expect(Object.values(ledger(w.temp.directory).days)).toEqual([
      { liveSeconds: 20, pausedSeconds: 6, sessions: 1, backendUsd: 0 },
    ]);
    // Minute caps count all billed seconds, including the paused part (20 s >= 18 s cap).
    expect(w.usage.capReason()).toContain("Daily");
  } finally {
    await w.cleanup();
  }
});

test("an inconsistent usage breakdown ends the loopback session as a provider failure", async () => {
  const w = loopback([{ type: "session.usage.updated", usage: { seconds: 9, active_seconds: 6, paused_seconds: 4 } }], {
    seconds: 9,
  });
  try {
    await w.session.done;
    expect(w.session.failed).toBe(true);
    expect(w.logs).toContain("VOICE_PROVIDER_ERROR");
    expect(w.received.map((event) => event["type"])).toEqual(["session.start", "session.close"]);
    expect(ledger(w.temp.directory).days["1970-01-01"]?.pausedSeconds).toBe(0);
  } finally {
    await w.cleanup();
  }
});

test("usage breakdown must add up to the billed total", () => {
  expect(
    parseLiveEvent({ type: "session.usage.updated", usage: { seconds: 9, active_seconds: 6, paused_seconds: 3 } }),
  ).toEqual({ type: "session.usage.updated", usage: { seconds: 9, active_seconds: 6, paused_seconds: 3 } });
  // Each breakdown field is optional on its own.
  for (const usage of [{ seconds: 9 }, { seconds: 9, active_seconds: 6 }, { seconds: 9, paused_seconds: 3 }])
    expect(parseLiveEvent({ type: "session.usage.updated", usage }).usage).toEqual(usage);
  for (const usage of [
    { seconds: 9, active_seconds: 6, paused_seconds: 4 },
    { seconds: 9, paused_seconds: 10 },
    { seconds: 9, active_seconds: 10 },
    { active_seconds: 6, paused_seconds: 3 },
    { seconds: 9, paused_seconds: -1 },
  ])
    expect(() => parseLiveEvent({ type: "session.usage.updated", usage })).toThrow();
});

test("ledgers without pausedSeconds still load; invalid paused values are refused, never reset", () => {
  const temp = temporaryVoice();
  try {
    const cfg = settings();
    const now = () => Date.parse("2026-11-20T00:00:00Z");
    const file = join(temp.directory, "usage.json");
    writeFileSync(file, '{"days":{"2026-11-20":{"liveSeconds":30,"sessions":1,"backendUsd":0}}}\n');
    const usage = new VoiceUsage(temp.directory, cfg, now);
    new LiveMeter(usage).record(5, 2);
    expect(ledger(temp.directory).days["2026-11-20"]).toEqual({
      liveSeconds: 35,
      pausedSeconds: 2,
      sessions: 1,
      backendUsd: 0,
    });
    // Wall time ahead of provider usage keeps the higher billed total; the later paused part is labeled within it.
    const meter = new LiveMeter(usage);
    meter.record(20);
    meter.record(15, 6);
    expect(ledger(temp.directory).days["2026-11-20"]).toMatchObject({ liveSeconds: 55, pausedSeconds: 8 });
    expect(() => usage.live("2026-11-20", 1, new Map([["2026-11-20", -1]]))).toThrow("Invalid Live usage");
    writeFileSync(file, '{"days":{"2026-11-20":{"liveSeconds":30,"pausedSeconds":-1,"sessions":1,"backendUsd":0}}}');
    expect(() => new VoiceUsage(temp.directory, cfg, now)).toThrow("refusing to reset");
  } finally {
    temp.cleanup();
  }
});

test("a paused report after midnight is attributed to the days that hold the session's billed time", () => {
  const temp = temporaryVoice();
  try {
    let now = Date.parse("2026-11-20T23:59:00Z");
    const usage = new VoiceUsage(temp.directory, settings(), () => now);
    const meter = new LiveMeter(usage);
    meter.record(60);
    now = Date.parse("2026-11-21T00:00:30Z");
    meter.record(60, 20);
    expect(ledger(temp.directory).days).toEqual({
      "2026-11-20": { liveSeconds: 60, pausedSeconds: 20, sessions: 0, backendUsd: 0 },
    });
    // Billed time on the new day takes newer paused seconds first; earlier days fill only the remainder.
    meter.record(90, 70);
    meter.record(90, 70);
    expect(ledger(temp.directory).days).toEqual({
      "2026-11-20": { liveSeconds: 60, pausedSeconds: 40, sessions: 0, backendUsd: 0 },
      "2026-11-21": { liveSeconds: 30, pausedSeconds: 30, sessions: 0, backendUsd: 0 },
    });
  } finally {
    temp.cleanup();
  }
});
