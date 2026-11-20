import { expect, test } from "bun:test";
import { FRAME_BYTES, TrackPacer } from "../src/voice/track-pacer.ts";

const voiced = (frames: number) => Buffer.alloc(frames * FRAME_BYTES, 0x11);
const silence = (frames: number) => Buffer.alloc(frames * FRAME_BYTES);

test("a preroll burst goes out at real time, at most three frames at once", () => {
  const pacer = new TrackPacer();
  pacer.push(voiced(5));
  expect(pacer.take(1000)).toHaveLength(3);
  expect(pacer.take(1000)).toHaveLength(0);
  expect(pacer.take(1020)).toHaveLength(1);
  expect(pacer.take(1040)).toHaveLength(1);
  expect(pacer.backlogMs()).toBe(0);
});

test("stall after stall, the backlog stays bounded instead of accumulating", () => {
  // The session feeds 20 ms per 20 ms of wall time; a 120 ms stall every second delivers the missed audio at once.
  const pacer = new TrackPacer();
  let now = 0;
  let fed = 0;
  let sent = 0;
  const backlog: number[] = [];
  for (let second = 0; second < 20; second++) {
    for (let tick = 0; tick < 50; tick++) {
      now += 20;
      if (tick >= 44) continue; // stalled: neither feed nor pump runs
      const owed = Math.floor(now / 20) - fed;
      pacer.push(voiced(owed));
      fed += owed;
      sent += pacer.take(now).length;
    }
    backlog.push(pacer.backlogMs());
  }
  expect(Math.max(...backlog)).toBeLessThanOrEqual(200);
  expect(sent + pacer.backlogMs() / 20).toBe(fed);
});

test("padding silence is dropped from a backlog; voiced audio is kept", () => {
  const pacer = new TrackPacer();
  pacer.push(Buffer.concat([voiced(2), silence(20), voiced(4)]));
  const frames = [];
  for (let now = 0; now <= 400; now += 20) frames.push(...pacer.take(now));
  const voicedOut = frames.filter(({ frame }) => frame.some((byte) => byte !== 0)).length;
  expect(voicedOut).toBe(6);
  expect(frames.length).toBeLessThan(26);
  expect(pacer.backlogMs()).toBe(0);
});

test("track time keeps running through a gap, so the next RTP timestamp reflects it", () => {
  const pacer = new TrackPacer();
  pacer.push(voiced(1));
  const [first] = pacer.take(0);
  for (let now = 20; now <= 200; now += 20) expect(pacer.take(now)).toHaveLength(0);
  pacer.push(voiced(1));
  const [next] = pacer.take(200);
  expect(first!.timestamp).toBe(0);
  expect(next!.timestamp).toBe(10 * 960);
});

test("speech fed in 40 ms batches with jitter keeps contiguous RTP timestamps", () => {
  const pacer = new TrackPacer();
  const stamps: number[] = [];
  for (let tick = 0; tick < 500; tick++) {
    const now = tick * 20 + (tick % 7);
    if (tick % 2 === 0) pacer.push(voiced(2));
    stamps.push(...pacer.take(now).map(({ timestamp }) => timestamp));
  }
  expect(stamps.length).toBeGreaterThan(490);
  expect(stamps.every((stamp, i) => i === 0 || stamp - (stamps[i - 1] ?? 0) === 960)).toBe(true);
});

test("a 40 ms batch that arrives 30 ms late, after empty pumps, does not skip a timestamp", () => {
  // The pump runs every 20 ms; batches land 1 ms after a pump, one of them 30 ms late (feeding jitter, not a gap).
  const pacer = new TrackPacer();
  const batches = [1, 41, 111, 121, 161, 201, 241, 281];
  const stamps: number[] = [];
  for (let now = 0; now < 600; now += 20) {
    stamps.push(...pacer.take(now).map(({ timestamp }) => timestamp / 960));
    for (const at of batches) if (at > now && at <= now + 20) pacer.push(voiced(2));
  }
  expect(stamps).toEqual([...Array(16).keys()]);
});

test("a late timer with audio still queued does not open a timestamp gap", () => {
  const pacer = new TrackPacer();
  pacer.push(voiced(20));
  const stamps = [...pacer.take(0), ...pacer.take(150), ...pacer.take(170)].map(({ timestamp }) => timestamp);
  // Three frames at once at each burst, numbered without a gap.
  expect(stamps).toEqual([0, 1, 2, 3, 4, 5, 6].map((slot) => slot * 960));
});

test("a pump that runs before the first audio does not break the RTP timestamps", () => {
  // The pump starts right after the SDP answer, usually before the session's first owner audio.
  const pacer = new TrackPacer();
  expect(pacer.take(0)).toHaveLength(0);
  pacer.push(voiced(2));
  expect(pacer.take(40).map(({ timestamp }) => timestamp)).toEqual([0, 960]);
});

test("more than five seconds of pending audio is refused", () => {
  const pacer = new TrackPacer();
  expect(pacer.push(voiced(250))).toBe(true);
  expect(pacer.push(voiced(1))).toBe(false);
});
