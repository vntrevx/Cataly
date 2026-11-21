import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export type DownloadedAttachment = {
  readonly filename: string;
  readonly savedPath: string;
  readonly bytes: number;
  readonly detectedType: string;
};

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function detectImageExtension(buf: Buffer): { ext: string; mime: string } | null {
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: ".webp", mime: "image/webp" };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: ".png", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (
    buf.length >= 6 &&
    (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { ext: ".gif", mime: "image/gif" };
  }
  return null;
}

function sanitizeFilename(name: string): string {
  const base = basename(name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return (base || "attachment").slice(0, 80);
}

export async function downloadDiscordAttachment(
  url: string,
  stateDir: string,
  opts: {
    readonly messageId?: string;
    readonly filename?: string;
    readonly maxBytes?: number;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<DownloadedAttachment> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`refused attachment URL outside Discord CDN: ${parsed.origin}`);
  }
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const fetcher = opts.fetchImpl ?? fetch;
  const res = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`attachment download failed: HTTP ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`attachment exceeds ${maxBytes} byte limit`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`attachment exceeds ${maxBytes} byte limit`);
  }

  const detected = detectImageExtension(buf);
  const rawName = sanitizeFilename(opts.filename ?? (parsed.pathname.split("/").pop() || "file"));
  const currentExt = extname(rawName).toLowerCase();
  const finalName =
    detected && currentExt !== detected.ext
      ? `${rawName.slice(0, rawName.length - currentExt.length) || "image"}${detected.ext}`
      : rawName;

  const dir = join(stateDir, "attachments");
  mkdirSync(dir, { recursive: true });
  const prefix = opts.messageId ? `${opts.messageId.replace(/[^0-9A-Za-z_-]/g, "")}-` : `${Date.now()}-`;
  const savedPath = join(dir, `${prefix}${finalName}`);
  writeFileSync(savedPath, buf);

  return {
    filename: finalName,
    savedPath,
    bytes: buf.length,
    detectedType: detected?.mime ?? res.headers.get("content-type") ?? "application/octet-stream",
  };
}
