import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ArgvTemplate, fill } from "../config.ts";
import type { Runner } from "../run.ts";

export class TranscriptionError extends Error {}

/** The platform resolver keeps credentials and resource URLs inside the immediate download. */
export type RemoteMedia = (
  signal: AbortSignal,
  maxBytes: number,
) => Promise<{
  name: string;
  response: Response;
  expectedSize: number;
}>;

/** Local paths stay untouched; only this invocation owns the downloaded file and directory. */
export const withLocalFile = async (
  source: string | RemoteMedia,
  maxBytes: number,
  use: (file: string) => Promise<string>,
  audio = true,
): Promise<string> => {
  if (typeof source === "string" && !/^https?:\/\//i.test(source)) return await use(source);
  const command = audio ? "transcribe" : "download";
  const kind = audio ? "audio" : "file";
  const limit = audio ? "transcribeMaxBytes" : "--max-bytes";
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new TranscriptionError(`${command}: invalid ${limit}; set ${limit} to a positive safe integer byte count`);
  const rejected = (reason: string, fix: string): TranscriptionError =>
    new TranscriptionError(`${command}: ${reason}; ${fix} (${audio ? "config: " : ""}${limit}=${maxBytes})`);
  const dir = mkdtempSync(join(tmpdir(), `dori-${kind}-`));
  try {
    let file: string;
    const abort = new AbortController();
    try {
      let opened: { name: string; response: Response; expectedSize?: number };
      if (typeof source === "string") {
        const url = new URL(source);
        opened = { name: basename(url.pathname) || kind, response: await fetch(url, { signal: abort.signal }) };
      } else opened = await source(abort.signal, maxBytes);
      const { response, expectedSize } = opened;
      const capacity = Math.min(maxBytes, expectedSize ?? maxBytes);
      if (!response.ok) throw rejected(`GET answered ${response.status}`, "check access or use a local file");
      const declared = response.headers.get("content-length");
      // Content-Length can include compression overhead; SDK size bounds decoded bytes below.
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes)
        throw rejected(`declared ${kind} size exceeds the limit`, `use smaller ${kind} or raise ${limit}`);
      if (!response.body) throw rejected(`URL response has no ${kind} body`, `provide ${kind} or use a local file`);
      file = join(dir, basename(opened.name) || kind);
      const fd = openSync(file, "wx+", 0o600);
      try {
        const reader = response.body.getReader();
        let total = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            // Count actual, decompressed bytes. Missing, zero or dishonest metadata never grants extra capacity.
            if (chunk.value.byteLength > capacity - total)
              throw rejected(`downloaded ${kind} exceeds the limit`, `use smaller ${kind} or raise ${limit}`);
            writeFileSync(fd, chunk.value);
            total += chunk.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        if (expectedSize !== undefined && total !== expectedSize)
          throw rejected(
            "attachment size does not match metadata",
            "check the original attachment or use a local file",
          );
        if (audio) {
          if (total === 0) throw rejected("URL audio is empty", "provide nonempty audio or use a local file");
          let head = Buffer.alloc(Math.min(total, 64));
          head = head.subarray(0, readSync(fd, head, 0, head.length, 0));
          const magic = head.toString("latin1", 0, 4);
          let mimes: readonly string[] = [];
          if (
            head.length >= 12 &&
            ["RIFF", "RIFX", "RF64"].includes(magic) &&
            head.toString("latin1", 8, 12) === "WAVE"
          )
            mimes = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
          else if (head.length >= 27 && magic === "OggS" && head.readUInt8(4) === 0)
            mimes = ["audio/ogg", "application/ogg", "audio/opus"];
          else if (head.length >= 8 && magic === "fLaC") mimes = ["audio/flac", "audio/x-flac"];
          else if (
            head.length >= 16 &&
            head.toString("latin1", 4, 8) === "ftyp" &&
            head.readUInt32BE(0) >= 16 &&
            head.readUInt32BE(0) <= total &&
            ["M4A ", "M4B ", "isom", "iso2", "iso5", "iso6", "mp41", "mp42", "dash"].includes(
              head.toString("latin1", 8, 12),
            )
          )
            mimes = ["audio/mp4", "audio/x-m4a", "application/mp4"];
          else {
            // ID3 is metadata, not proof of MP3 audio. Check the MPEG frame header after its bounded tag.
            if (
              head.length >= 10 &&
              head.toString("latin1", 0, 3) === "ID3" &&
              [2, 3, 4].includes(head.readUInt8(3)) &&
              [6, 7, 8, 9].every((i) => head.readUInt8(i) < 128)
            ) {
              const tagSize = [6, 7, 8, 9].reduce((size, i) => (size << 7) | head.readUInt8(i), 0);
              const offset = 10 + tagSize + (head.readUInt8(3) === 4 && (head.readUInt8(5) & 0x10) !== 0 ? 10 : 0);
              if (offset <= total - 4) {
                head = Buffer.alloc(4);
                head = head.subarray(0, readSync(fd, head, 0, 4, offset));
              }
            }
            if (
              head.length >= 4 &&
              head.readUInt8(0) === 0xff &&
              (head.readUInt8(1) & 0xe0) === 0xe0 &&
              ((head.readUInt8(1) >> 3) & 3) !== 1 &&
              ((head.readUInt8(1) >> 1) & 3) === 1 &&
              head.readUInt8(2) >> 4 > 0 &&
              head.readUInt8(2) >> 4 < 15 &&
              ((head.readUInt8(2) >> 2) & 3) !== 3
            )
              mimes = ["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/mpeg3", "audio/x-mpeg"];
          }
          if (!mimes.length)
            throw rejected(
              "unsupported or truncated audio signature",
              "convert to WAV, MP3, Ogg, M4A or FLAC, or use a local file",
            );
          const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
          if (mime && !["application/octet-stream", "binary/octet-stream"].includes(mime) && !mimes.includes(mime))
            throw rejected(
              "Content-Type does not match the audio signature",
              "correct the server MIME type or use a local file",
            );
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw rejected(`could not download ${kind}`, "check the URL/network and temporary storage, or use a local file");
    } finally {
      // Also abort unopened/error response bodies; never keep receiving after a limit failure.
      abort.abort();
    }
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const transcribe = async (run: Runner, hook: ArgvTemplate | undefined, audioPath: string): Promise<string> => {
  if (!hook?.length) throw new TranscriptionError("no hooks.transcribe configured");
  const r = await run(fill(hook, { file: audioPath }));
  const text = r.out.trim();
  if (r.code !== 0 || !text)
    throw new TranscriptionError(`transcription failed (exit ${r.code}): ${r.err.slice(0, 160)}`);
  return text;
};
