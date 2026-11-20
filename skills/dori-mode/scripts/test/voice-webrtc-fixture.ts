/**
 * A loopback stand-in for `POST /v1/live/sessions` with WebRTC transport: a local HTTP endpoint answers the SDP offer
 * with its own werift peer, then talks over the `oai-events` data channel and an Opus track. No OpenAI endpoint or key.
 */
import * as rtc from "werift";
import { Playback } from "../src/voice/audio.ts";
import type { OpusCodec } from "../src/voice/discord-link.ts";
import { Replies } from "../src/voice/replies.ts";
import { VoiceSession } from "../src/voice/session.ts";
import type { VoiceSettings } from "../src/voice/settings.ts";
import type { Wire } from "../src/voice/types.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { webrtcSocket } from "../src/voice/webrtc.ts";
import { temporaryVoice } from "./voice-fixture.ts";

const codecs = {
  audio: [new rtc.RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48_000, channels: 2, payloadType: 111 })],
};

/**
 * Stands in for the optional native Opus codec, which CI does not install: a "packet" is the first 5 ms of the frame,
 * small enough for one datagram, and decodes to those samples. Level checks on the far side still hold.
 */
const fakeOpus = (): OpusCodec => ({
  encode: (pcm) => Buffer.from(pcm.subarray(0, 480)),
  decode: (packet) => Buffer.from(packet),
});

/** 20 ms of a loud 48 kHz mono tone. */
export const toneFrame = (): Buffer => {
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin((i / 960) * 2 * Math.PI * 20) * 12_000), i * 2);
  return pcm;
};

/** The creation request as the client sends it. */
type CreateBody = { session: object; transport: { type: unknown; sdp: string } };
const isCreateBody = (raw: unknown): raw is CreateBody =>
  typeof raw === "object" &&
  raw !== null &&
  "session" in raw &&
  typeof raw.session === "object" &&
  raw.session !== null &&
  "transport" in raw &&
  typeof raw.transport === "object" &&
  raw.transport !== null &&
  "type" in raw.transport &&
  "sdp" in raw.transport &&
  typeof raw.transport.sdp === "string";

export const fakeLiveWebrtc = (options: { status?: number } = {}) => {
  const requests: { authorization: string | null; body: CreateBody }[] = [];
  const received: Wire[] = [];
  const inbound: Buffer[] = [];
  const decoder = fakeOpus();
  const encoder = fakeOpus();
  const connected = Promise.withResolvers<void>();
  const speaker = new rtc.MediaStreamTrack({ kind: "audio" });
  let peer: rtc.RTCPeerConnection | undefined;
  let channel: rtc.RTCDataChannel | undefined;
  let onEvent: (event: Wire) => void = () => {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      if (!isCreateBody(body)) return Response.json({ error: { code: "bad_request" } }, { status: 400 });
      requests.push({ authorization: request.headers.get("authorization"), body });
      if (options.status) return Response.json({ error: { code: "fake" } }, { status: options.status });
      const pc = new rtc.RTCPeerConnection({ codecs, iceServers: [], iceUseDefaultStunServer: false });
      peer = pc;
      pc.onTransceiverAdded.subscribe((transceiver) => {
        transceiver.setDirection("sendrecv");
        void transceiver.sender.replaceTrack(speaker);
        transceiver.onTrack.subscribe((track) =>
          track.onReceiveRtp.subscribe((packet) => inbound.push(decoder.decode(packet.payload))),
        );
      });
      pc.onDataChannel.subscribe((dc) => {
        channel = dc;
        dc.onMessage.subscribe((data) => {
          const event: Wire = JSON.parse(String(data));
          received.push(event);
          onEvent(event);
        });
        connected.resolve();
      });
      await pc.setRemoteDescription({ type: "offer", sdp: body.transport.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete") await pc.iceGatheringStateChange.watch((s) => s === "complete");
      return Response.json(
        { session: { id: "live_fake" }, transport: { type: "webrtc", sdp: pc.localDescription?.sdp } },
        { status: 201 },
      );
    },
  });
  let sequence = 0;
  return {
    url: `http://127.0.0.1:${server.port}/v1/live/sessions`,
    requests,
    received,
    inbound,
    connected: connected.promise,
    on: (handler: (event: Wire) => void) => {
      onEvent = handler;
    },
    send: (event: Wire) => channel?.send(JSON.stringify(event)),
    /** Plays `frames` 20 ms tone frames on the model's track. */
    speak: (frames: number) => {
      for (let i = 0; i < frames; i++) {
        const header = new rtc.RtpHeader({ payloadType: 111, sequenceNumber: sequence, timestamp: sequence * 960 });
        sequence++;
        speaker.writeRtp(new rtc.RtpPacket(header, encoder.encode(toneFrame())));
      }
    },
    /** Drops the peer connection without a session.closed, as a lost network path would. */
    drop: () => peer?.close(),
    stop: async () => {
      await peer?.close();
      await server.stop(true);
    },
  };
};

/** A VoiceSession on the WebRTC transport against `url`, with a 40 ms tick like the CLI. */
export const webrtcSession = (config: VoiceSettings, url: string, greet = false, codec: () => OpusCodec = fakeOpus) => {
  const temp = temporaryVoice();
  const logs: string[] = [];
  let finished = 0;
  const started = Promise.withResolvers<void>();
  const playback = new Playback();
  const usage = new VoiceUsage(temp.directory, config, Date.now);
  const session = new VoiceSession(
    config,
    {
      now: Date.now,
      key: "synthetic-no-paid-key",
      open: webrtcSocket(rtc, codec, (line) => logs.push(line), url),
      playback,
      replies: new Replies(temp.directory, () => {}),
      usage,
      tool: async () => ({ ok: true, result: "unused" }),
      log: (line) => logs.push(line),
      started: () => started.resolve(),
      finished: async () => {
        finished++;
      },
    },
    greet,
  );
  const ticker = setInterval(() => session.tick(), 40);
  session.open();
  return {
    temp,
    logs,
    playback,
    usage,
    session,
    started: started.promise,
    finished: () => finished,
    cleanup: async () => {
      if (session.state !== "closed") session.close("shutdown");
      await session.done;
      clearInterval(ticker);
      temp.cleanup();
    },
  };
};

/** Resolves once `check` holds, polling every 20 ms for up to `ms`. */
export const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
};
