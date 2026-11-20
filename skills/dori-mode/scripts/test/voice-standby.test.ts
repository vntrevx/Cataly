import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Discord } from "../src/messenger/discord.ts";
import { summarizeVoice } from "../src/voice/summary.ts";
import { LiveMeter, VoiceUsage } from "../src/voice/usage.ts";
import { flush, settings, temporaryVoice } from "./voice-fixture.ts";
import { fixture } from "./voice-session-fixture.ts";

const standby = { transport: "webrtc", standby: { idleTimeoutSec: 10, dailyMinuteCap: 5 } } as const;
const offers = (wires: Record<string, unknown>[]) =>
  wires.filter((wire) => wire["type"] === "session.commentary.append").length;

test("a standby session does not greet and holds lead replies until the owner's speech resumes it", async () => {
  const f = fixture(standby);
  try {
    writeFileSync(join(f.directory, "lead-replies.jsonl"), `${JSON.stringify({ re: "request", text: "Done." })}\n`);
    const current = await f.start();
    f.time(5000);
    f.engine.tick();
    expect(offers(current.wires)).toBe(0);
    current.handlers.event({ type: "session.resumed" });
    await flush();
    f.time(6100);
    f.engine.tick();
    expect(offers(current.wires)).toBe(1);
    expect(f.logs).toContain("VOICE_SESSION_RESUMED");
    current.handlers.event({ type: "session.paused" });
    await flush();
    expect(f.logs).toContain("VOICE_SESSION_PAUSED");
    current.handlers.closed();
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("the same reply is offered at once without standby", async () => {
  const f = fixture({ transport: "webrtc" });
  try {
    writeFileSync(join(f.directory, "lead-replies.jsonl"), `${JSON.stringify({ re: "request", text: "Done." })}\n`);
    const current = await f.start();
    // The greeting, then the reply at the first pause.
    expect(offers(current.wires)).toBe(1);
    f.time(5000);
    f.engine.tick();
    expect(offers(current.wires)).toBe(2);
    current.handlers.closed();
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("with standby, minute caps count active seconds and standby seconds meet their own daily cap", () => {
  const temp = temporaryVoice();
  try {
    const usage = new VoiceUsage(temp.directory, settings({ ...standby, dailyMinuteCap: 2 }), () => 0);
    const meter = new LiveMeter(usage);
    // Without paused_seconds, the active part implies the paused rest.
    meter.provider({ seconds: 290, active_seconds: 60 });
    expect(meter.paused).toBe(230);
    expect(usage.capReason()).toBeUndefined();
    meter.provider({ seconds: 310, paused_seconds: 300 });
    expect(usage.capReason()).toBe("Daily voice standby limit reached");
    const active = new VoiceUsage(temp.directory, settings({ ...standby, dailyMinuteCap: 0.1 }), () => 0);
    expect(active.capReason()).toBe("Daily voice time limit reached");
    // The same ledger without standby keeps counting every billed second against the minute caps.
    expect(new VoiceUsage(temp.directory, settings({ dailyMinuteCap: 5 }), () => 0).capReason()).toBe(
      "Daily voice time limit reached",
    );
    expect(new VoiceUsage(temp.directory, settings({ dailyMinuteCap: 6 }), () => 0).capReason()).toBeUndefined();
  } finally {
    temp.cleanup();
  }
});

test("the summary prices active and standby minutes only when Live rates are configured", async () => {
  const temp = temporaryVoice();
  const sent: string[] = [];
  const discord = new Discord(
    async (request) => {
      sent.push(String(request.body));
      return { status: 200, headers: {}, body: '{"id":"summary-note"}' };
    },
    { now: () => 0, sleep: async () => {} },
    "synthetic-discord",
  );
  try {
    const priced = settings({ livePrices: { active: 0.05, standby: 0.02 } });
    const usage = new VoiceUsage(temp.directory, priced, () => 0);
    const session = () => ({
      inputTranscript: ["hello"],
      outputTranscript: [],
      actions: [],
      failed: true,
      meter: { seconds: 180, paused: 120 },
    });
    await summarizeVoice(session(), priced, usage, "unused", discord);
    expect(sent[0]).toContain("Live time: 1.0 min active, 2.0 min standby; estimated $0.09 at configured rates");
    await summarizeVoice(session(), settings(), usage, "unused", discord);
    expect(sent[1]).not.toContain("Live time");
  } finally {
    temp.cleanup();
  }
});
