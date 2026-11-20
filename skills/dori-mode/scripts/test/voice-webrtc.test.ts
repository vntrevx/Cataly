import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rmsDbfs } from "../src/voice/audio.ts";
import { startEvent } from "../src/voice/prompts.ts";
import { settings } from "./voice-fixture.ts";
import { fakeLiveWebrtc, toneFrame, until, webrtcSession } from "./voice-webrtc-fixture.ts";

const standby = settings({
  transport: "webrtc",
  liveModel: "gpt-live-1.1",
  voice: "marin",
  standby: { idleTimeoutSec: 15, vadThreshold: 0.6, dailyMinuteCap: 10 },
});
type Ledger = { days: Record<string, { liveSeconds: number; pausedSeconds: number }> };
const day = (directory: string) => {
  const ledger: Ledger = JSON.parse(readFileSync(join(directory, "usage.json"), "utf8"));
  return Object.values(ledger.days)[0]!;
};
/** 24 kHz mono, as the Discord bridge hands owner audio to the session. */
const owner = (ms: number) => {
  const frame = toneFrame();
  const out = Buffer.alloc((ms / 20) * 960);
  for (let f = 0; f < ms / 20; f++)
    for (let i = 0; i < 480; i++) out.writeInt16LE(frame.readInt16LE(i * 4), f * 960 + i * 2);
  return out;
};

test("a standby WebRTC session is created by one HTTP request and carries events, audio and standby usage", async () => {
  const live = fakeLiveWebrtc();
  const w = webrtcSession(standby, live.url, true);
  try {
    await live.connected;
    live.send({ type: "session.started", session: { id: "live_fake" } });
    await w.started;
    expect(live.requests).toHaveLength(1);
    const { authorization, body } = live.requests[0]!;
    expect(authorization).toBe("Bearer synthetic-no-paid-key");
    expect(body.transport).toMatchObject({ type: "webrtc", sdp: expect.stringContaining("opus/48000/2") });
    expect(body.session).toMatchObject({
      model: "gpt-live-1.1",
      audio: { output: { voice: "marin" } },
      wake_policy: { type: "speech", vad_threshold: 0.6 },
      idle_timeout_s: 15,
    });
    expect(body.session).not.toHaveProperty(["audio", "format"]);

    // The owner's audio reaches the provider's track; the model's track reaches Discord playback.
    w.session.inputAudio(owner(600), true);
    await until(() => live.inbound.length >= 20);
    expect(Math.max(...live.inbound.map((pcm) => rmsDbfs(pcm)))).toBeGreaterThan(-30);
    live.speak(10);
    await until(() => w.playback.queuedMs() > 0);

    live.send({ type: "session.resumed" });
    live.send({ type: "session.paused" });
    live.send({ type: "session.usage.updated", usage: { seconds: 60, active_seconds: 20, paused_seconds: 40 } });
    await until(() => w.logs.includes("VOICE_SESSION_PAUSED"));
    await until(() => day(w.temp.directory).pausedSeconds === 40);
    // Standby time does not count as active: 20 of a 10-minute daily active cap is far from it.
    expect(w.usage.capReason()).toBeUndefined();

    live.on((event) => {
      if (event["type"] === "session.close")
        live.send({ type: "session.closed", reason: "close_requested", usage: { seconds: 61, paused_seconds: 40 } });
    });
    w.session.close("shutdown");
    await w.session.done;
    expect(w.session.failed).toBe(false);
    expect(day(w.temp.directory)).toMatchObject({ liveSeconds: 61, pausedSeconds: 40 });
    // No session.start on the data channel, and a standby session does not greet before the owner speaks.
    expect(live.received.map((event) => event["type"])).toEqual(["session.close"]);
    expect(w.logs).toContain("VOICE_SESSION_RESUMED");
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("a WebRTC session without standby greets over the data channel", async () => {
  const live = fakeLiveWebrtc();
  const w = webrtcSession(settings({ transport: "webrtc" }), live.url, true);
  try {
    await live.connected;
    live.send({ type: "session.started", session: { id: "live_fake" } });
    await until(() => live.received.some((event) => event["type"] === "session.commentary.append"));
    expect(live.requests[0]!.body.session).not.toHaveProperty("wake_policy");
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("a rejected creation request closes the session once, with no retry", async () => {
  const live = fakeLiveWebrtc({ status: 500 });
  const w = webrtcSession(standby, live.url);
  try {
    await w.session.done;
    expect(w.session.failed).toBe(true);
    expect(w.session.state).toBe("closed");
    expect(w.logs).toContain("VOICE_PROVIDER_ERROR");
    expect(w.logs).toContain("VOICE_WEBRTC_CREATE_FAILED HTTP 500 fake");
    expect(w.logs.join("\n")).not.toContain("synthetic-no-paid-key");
    expect(live.requests).toHaveLength(1);
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("a created session that ends before session.started still records the 15 s initialization charge", async () => {
  const live = fakeLiveWebrtc();
  const w = webrtcSession(standby, live.url);
  try {
    await live.connected;
    w.session.close("owner left");
    await w.session.done;
    expect(day(w.temp.directory).liveSeconds).toBe(15);
    expect(live.requests).toHaveLength(1);
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("losing the peer connection ends the session as a failure and keeps its billed time", async () => {
  const live = fakeLiveWebrtc();
  const w = webrtcSession(standby, live.url);
  try {
    await live.connected;
    live.send({ type: "session.started", session: { id: "live_fake" } });
    await w.started;
    await live.drop();
    await w.session.done;
    expect(w.session.failed).toBe(true);
    expect(w.session.state).toBe("closed");
    expect(day(w.temp.directory).liveSeconds).toBeGreaterThanOrEqual(15);
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("an Opus encoder failure on the paced track ends the session once instead of escaping the timer", async () => {
  const live = fakeLiveWebrtc();
  const broken = () => ({
    encode: () => {
      throw new Error("encoder broke");
    },
    decode: (packet: Buffer) => packet,
  });
  const w = webrtcSession(standby, live.url, false, broken);
  try {
    await live.connected;
    live.send({ type: "session.started", session: { id: "live_fake" } });
    await w.started;
    w.session.inputAudio(owner(100), true);
    await w.session.done;
    expect(w.session.failed).toBe(true);
    expect(w.logs.filter((line) => line === "VOICE_PROVIDER_ERROR")).toHaveLength(1);
    expect(w.finished()).toBe(1);
  } finally {
    await w.cleanup();
    await live.stop();
  }
}, 20_000);

test("only the WebRTC start configuration drops the PCM format and adds the standby fields", () => {
  const ws = startEvent(settings());
  expect(ws).toHaveProperty(["session", "audio"], {
    format: { type: "audio/pcm", rate: 24_000 },
    output: { voice: "fixture-voice" },
  });
  expect(ws).not.toHaveProperty(["session", "wake_policy"]);
  expect(ws).not.toHaveProperty(["session", "idle_timeout_s"]);
  const rtc = startEvent(settings({ transport: "webrtc", standby: { idleTimeoutSec: 5, dailyMinuteCap: 1 } }));
  expect(rtc["session"]).toMatchObject({ wake_policy: { type: "speech" }, idle_timeout_s: 5 });
  expect(rtc).not.toHaveProperty(["session", "wake_policy", "vad_threshold"]);
  expect(rtc).not.toHaveProperty(["session", "audio", "format"]);
});

test("standby settings require the WebRTC transport, a 5-60 s whole timeout and an explicit standby cap", () => {
  expect(settings().transport).toBe("websocket");
  const bad: [Record<string, unknown>, string][] = [
    [{ transport: "sip" }, "voice.transport"],
    [{ standby: { idleTimeoutSec: 15, dailyMinuteCap: 10 } }, "requires voice.transport"],
    [{ transport: "webrtc", standby: { idleTimeoutSec: 4, dailyMinuteCap: 10 } }, "idleTimeoutSec"],
    [{ transport: "webrtc", standby: { idleTimeoutSec: 61, dailyMinuteCap: 10 } }, "idleTimeoutSec"],
    [{ transport: "webrtc", standby: { idleTimeoutSec: 7.5, dailyMinuteCap: 10 } }, "idleTimeoutSec"],
    [{ transport: "webrtc", standby: { idleTimeoutSec: 15, vadThreshold: 2, dailyMinuteCap: 10 } }, "vadThreshold"],
    [{ transport: "webrtc", standby: { idleTimeoutSec: 15 } }, "dailyMinuteCap is required"],
    [{ transport: "webrtc", standby: null }, "idleTimeoutSec"],
    [{ livePrices: { active: 0.05 } }, "livePrices"],
  ];
  for (const [patch, message] of bad) expect(() => settings(patch)).toThrow(message);
});
