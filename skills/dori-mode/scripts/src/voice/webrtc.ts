/**
 * The Live session over WebRTC (opt-in, voice.transport="webrtc"), the only transport with standby. `POST
 * /v1/live/sessions` starts the session with an SDP offer; JSON events travel on the `oai-events` data channel and
 * audio on an Opus media track. The adapter keeps the primary WebSocket's event vocabulary, so the session is unchanged:
 * its `session.start` becomes the creation request, `session.input_audio.append` feeds the track and received audio
 * comes back as `session.output_audio.delta`. werift (pure TypeScript) and the optional Opus codec load only when
 * `dori voice discord` starts with this transport.
 */
import type * as Werift from "werift";
import type { OpusCodec } from "./discord-link.ts";
import { parseLiveEvent } from "./provider.ts";
import { TrackPacer } from "./track-pacer.ts";
import type { OpenVoiceSocket, Wire } from "./types.ts";

type Rtc = Pick<
  typeof Werift,
  "RTCPeerConnection" | "RTCRtpCodecParameters" | "MediaStreamTrack" | "RtpPacket" | "RtpHeader"
>;
type Request = (url: string, init: RequestInit) => Promise<Response>;

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const PAYLOAD_TYPE = 111;
/** Voice duration OpenAI bills when a WebRTC session is created (documented 2026-11-20). */
const INIT_BILLED_SECONDS = 15;

/** 24 kHz mono to 48 kHz mono, interpolating across chunk boundaries through `state.previous`. */
const upsample = (pcm24: Buffer, state: { previous: number }): Buffer => {
  const n = pcm24.length >> 1;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = pcm24.readInt16LE(i * 2);
    out.writeInt16LE((state.previous + s) >> 1, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
    state.previous = s;
  }
  return out;
};

/** 48 kHz mono to 24 kHz mono by averaging sample pairs. */
const downsample = (pcm48: Buffer): Buffer => {
  const n = pcm48.length >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE((pcm48.readInt16LE(i * 4) + pcm48.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  return out;
};

/**
 * `codec` makes a 48 kHz mono Opus codec. Host candidates only: no STUN server is queried, as with a browser's default
 * configuration. A creation request is sent once and never retried; a failed one ends the transport.
 */
export const webrtcSocket =
  (
    rtc: Rtc,
    codec: () => OpusCodec,
    log: (line: string) => void,
    url = LIVE_SESSIONS_URL,
    request: Request = fetch,
    clock = performance,
  ): OpenVoiceSocket =>
  (key, handlers) => {
    const pc = new rtc.RTCPeerConnection({
      codecs: {
        audio: [
          new rtc.RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
            payloadType: PAYLOAD_TYPE,
          }),
        ],
      },
      iceServers: [],
      iceUseDefaultStunServer: false,
    });
    const channel = pc.createDataChannel("oai-events");
    const mic = new rtc.MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(mic, { direction: "sendrecv" });
    const encoder = codec();
    const decoder = codec();
    const abort = new AbortController();
    const resample = { previous: 0 };
    const pacer = new TrackPacer();
    const ssrc = (Math.random() * 2 ** 32) >>> 0;
    let sequence = 0;
    let started = false;
    let ended = false;
    let pump: NodeJS.Timeout | undefined;

    const end = (failed: boolean) => {
      if (ended) return;
      ended = true;
      clearInterval(pump);
      abort.abort();
      try {
        channel.close();
        mic.stop();
      } catch {}
      void pc.close().catch(() => undefined);
      if (failed) handlers.error();
      handlers.closed();
    };
    const send = () => {
      for (const { frame, timestamp } of pacer.take(clock.now())) {
        const header = new rtc.RtpHeader({ payloadType: PAYLOAD_TYPE, sequenceNumber: sequence, timestamp, ssrc });
        mic.writeRtp(new rtc.RtpPacket(header, encoder.encode(frame)));
        sequence = (sequence + 1) & 0xffff;
      }
    };

    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => {
        if (ended) return;
        let pcm: Buffer;
        try {
          pcm = decoder.decode(packet.payload);
        } catch {
          return; // A corrupt Opus frame is skipped, as on the Discord side.
        }
        handlers.event({ type: "session.output_audio.delta", delta: downsample(pcm).toString("base64") });
      });
    });
    channel.onMessage.subscribe((data) => {
      if (ended) return;
      try {
        handlers.event(parseLiveEvent(JSON.parse(String(data))));
      } catch {
        handlers.error();
      }
    });
    channel.stateChanged.subscribe((state) => {
      if (state === "closed") end(false);
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed") end(true);
    });

    const create = async (session: unknown) => {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete") await pc.iceGatheringStateChange.watch((s) => s === "complete");
      const response = await request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp: pc.localDescription?.sdp } }),
        signal: abort.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        throw new Error(`HTTP ${response.status} ${code}`.trim());
      }
      const transport = body && typeof body === "object" && "transport" in body ? body.transport : undefined;
      const sdp = transport && typeof transport === "object" && "sdp" in transport ? transport.sdp : undefined;
      if (typeof sdp !== "string" || !sdp) throw new Error("Live session response has no SDP answer");
      // Creation bills 15 s of initialization, credited against the running session's cumulative usage: record it
      // now, so a session that ends before session.started still counts it and later usage does not add it again.
      handlers.event({ type: "session.usage.updated", usage: { seconds: INIT_BILLED_SECONDS } });
      if (ended) return;
      await pc.setRemoteDescription({ type: "answer", sdp });
      if (ended) return;
      // A codec or track failure ends the transport as a provider failure instead of escaping the timer.
      pump = setInterval(() => {
        try {
          send();
        } catch {
          end(true);
        }
      }, 20);
    };

    queueMicrotask(() => {
      if (!ended) handlers.open();
    });
    return {
      send: (event: Wire) => {
        if (ended) throw new Error("Live WebRTC transport is closed");
        if (event["type"] === "session.start") {
          if (started) throw new Error("Live WebRTC session already started");
          started = true;
          create(event["session"]).catch((error: unknown) => {
            if (!ended) log(`VOICE_WEBRTC_CREATE_FAILED ${error instanceof Error ? error.message : "unknown"}`);
            end(true);
          });
        } else if (event["type"] === "session.input_audio.append") {
          if (!pacer.push(upsample(Buffer.from(String(event["audio"]), "base64"), resample))) handlers.error();
        } else if (channel.readyState === "open") channel.send(JSON.stringify(event));
        else throw new Error("Live WebRTC data channel is not open");
      },
      close: () => end(false),
      terminate: () => end(false),
    };
  };

/** Loads the optional WebRTC and Opus packages; called only when voice.transport is "webrtc". */
export const openWebrtcVoice = async (log: (line: string) => void): Promise<OpenVoiceSocket> => {
  // Dynamic on purpose: optional dependencies, absent or unloadable where this transport is not used.
  const rtc = await import("werift");
  const { OpusEncoder } = await import("@discordjs/opus");
  return webrtcSocket(rtc, () => new OpusEncoder(48_000, 1), log);
};
