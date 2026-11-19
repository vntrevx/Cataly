import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { audioSamples } from "./audio-samples.ts";
import { type DiscordRoute, withDiscordCli } from "./discord-fakes.ts";

// F54: token-free Discord attachment refs resolve through owner-scoped REST metadata, then a credential-free CDN GET.
const ref = "discord-file:99:10:20:101:500";
const secret = "hm=signed-secret";
const cdnUrl = (name: string, channel = "20") =>
  `https://cdn.discordapp.com/attachments/${channel}/500/${name}?ex=1&${secret}`;
const cdnKey = (name: string, channel = "20") => `GET /attachments/${channel}/500/${name}?ex=1&${secret}`;
const rest = ["GET /users/@me", "GET /channels/20", "GET /channels/20/messages/101"];
const environment = {
  DORI_DISCORD_TOKEN: "synthetic-ops-token",
  DORI_DISCORD_OWNER_ID: "10",
  DORI_DISCORD_CHANNEL_ID: "20",
  DORI_DISCORD_CHANNEL_IDS: undefined,
  DORI_DISCORD_SCOPE: undefined,
  DORI_DISCORD_THREADS: undefined,
};
const discordRoutes = (name: string, bytes: Buffer, cdn: DiscordRoute = {}, size = bytes.length) => ({
  "GET /users/@me": { body: { id: "99", bot: true, username: "dori" } },
  "GET /channels/20/messages/101": {
    body: {
      id: "101",
      channel_id: "20",
      type: 0,
      author: { id: "10", bot: false },
      attachments: [{ id: "500", filename: name, size, url: cdnUrl(name) }],
    },
  },
  [cdnKey(name)]: { base64: bytes.toString("base64"), ...cdn },
});
const secretFree = (text: string): void => {
  for (const leaked of [secret, "synthetic-ops-token", "cdn.discordapp.com", "/attachments/"]) {
    expect(text).not.toContain(leaked);
  }
};

test("an audio ref transcribes the exact CDN bytes after bot, channel and owner-message checks", async () => {
  await withDiscordCli(async (f) => {
    const bytes = Buffer.from(audioSamples.ogg, "base64");
    const r = await f.invoke(["transcribe", ref], {
      environment,
      routes: discordRoutes("voice.ogg", bytes, { headers: { "content-type": "audio/ogg" } }),
    });
    expect([r.code, r.err, r.out, r.keys]).toEqual([
      0,
      "",
      bytes.toString("utf8").trim(),
      [...rest, cdnKey("voice.ogg")],
    ]);
    expect(r.audio.map((audio) => [audio.base64, audio.fileMode, audio.dirMode])).toEqual([
      [audioSamples.ogg, 0o600, 0o700],
    ]);
    expect(existsSync(r.audio[0]!.file)).toBe(false);
    expect(readdirSync(f.tmp)).toEqual([]);
    const cdn = r.network.at(-1)!;
    expect(new URL(cdn.href).host).toBe("cdn.discordapp.com");
    expect([cdn.redirect, cdn.credentials, cdn.authorization, cdn.signal]).toEqual(["error", "omit", false, true]);
    expect(r.network.slice(0, 3).every((call) => call.authorization)).toBe(true);
  });
});

test("the transcribe ref path keeps F55 signature checks", async () => {
  await withDiscordCli(async (f) => {
    const pdf = Buffer.from("%PDF-1.7\nnot audio");
    const r = await f.invoke(["transcribe", ref], {
      environment,
      routes: discordRoutes("voice.ogg", pdf, { headers: { "content-type": "audio/ogg" } }),
    });
    expect([r.code, r.out, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], []]);
    expect(r.err).toContain("unsupported or truncated");
    secretFree(r.err);
  });
});

test.each([
  ["report.pdf", Buffer.from("%PDF-1.7\nreport"), "application/pdf"],
  ["photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), "image/png"],
  ["empty.txt", Buffer.alloc(0), "text/plain"],
] as const)("download saves %s privately without audio MIME rules", async (name, bytes, type) => {
  await withDiscordCli(async (f) => {
    const out = join(dirname(f.tmp), `saved-${name}`);
    const r = await f.invoke(["download", ref, "--out", out], {
      environment,
      hook: null,
      routes: discordRoutes(name, bytes, { headers: { "content-type": type } }),
    });
    expect([r.code, r.err, r.out, r.keys, r.audio]).toEqual([
      0,
      "",
      `DOWNLOADED ${JSON.stringify(out)}`,
      [...rest, cdnKey(name)],
      [],
    ]);
    expect(readFileSync(out)).toEqual(bytes);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.tmp)).toEqual([]);
  });
});

test("download never overwrites an existing target", async () => {
  await withDiscordCli(async (f) => {
    const out = join(dirname(f.tmp), "existing.pdf");
    writeFileSync(out, "keep me");
    const r = await f.invoke(["download", ref, "--out", out], {
      environment,
      routes: discordRoutes("report.pdf", Buffer.from("%PDF-1.7\nnew")),
    });
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(readFileSync(out, "utf8")).toBe("keep me");
    expect(readdirSync(f.tmp)).toEqual([]);
  });
});

const body = Buffer.from("%PDF-1.7\n0123456789");
test.each([
  ["metadata above --max-bytes", ["--max-bytes", "8"], {}, body.length, false],
  ["body longer than metadata", [], {}, body.length - 4, true],
  ["body shorter than metadata", [], {}, body.length + 4, true],
  [
    "streamed body above --max-bytes",
    ["--max-bytes", String(body.length - 1)],
    { chunks: [body.subarray(0, 10).toString("base64"), body.subarray(10).toString("base64")] },
    body.length - 2,
    true,
  ],
] as const)("download refuses %s and leaves no output or temp", async (_name, flags, cdn, size, fetched) => {
  await withDiscordCli(async (f) => {
    const out = join(dirname(f.tmp), "refused.pdf");
    const r = await f.invoke(["download", ref, "--out", out, ...flags], {
      environment,
      routes: discordRoutes("report.pdf", body, cdn as DiscordRoute, size),
    });
    expect([r.code, r.out, existsSync(out), r.audio, readdirSync(f.tmp)]).toEqual([1, "", false, [], []]);
    expect(r.keys.includes(cdnKey("report.pdf"))).toBe(fetched);
    secretFree(r.err);
  });
});

test.each(["0", "-1", "1.5", "25MiB", "9007199254740992", ""])(
  "--max-bytes %p is refused before any network or temp directory",
  async (limit) => {
    await withDiscordCli(async (f) => {
      const out = join(dirname(f.tmp), "never.bin");
      const r = await f.invoke(["download", ref, "--out", out, "--max-bytes", limit], {
        environment,
        routes: discordRoutes("report.pdf", body),
      });
      expect([r.code, r.out, r.keys, r.network, existsSync(out), readdirSync(f.tmp)]).toEqual([
        1,
        "",
        [],
        [],
        false,
        [],
      ]);
    });
  },
);

test.each([
  ["a plain URL", "https://cdn.example/audio/voice.ogg?token=private"],
  ["a local file", "LOCAL"],
  ["a local reserved-looking path", "./discord-file:99:10:20:101:500"],
])("download refuses %s without fetching", async (_name, input) => {
  await withDiscordCli(async (f) => {
    const out = join(dirname(f.tmp), "never.bin");
    const r = await f.invoke(["download", input === "LOCAL" ? f.local : input, "--out", out], { environment });
    expect([r.code, r.out, r.keys, existsSync(out), readdirSync(f.tmp)]).toEqual([1, "", [], false, []]);
    expect(r.err).not.toContain("token=private");
  });
});

test.each([
  "discord-file:99:10:20:101",
  "discord-file:99:10:20:101:500:7",
  "discord-file:99:10:20:101:abc",
  "discord-file:99:10:20:101:0500",
  "discord-file::10:20:101:500",
  "discord-file:99:10:20:101:500?x=1",
  "discord-file:99:10:20:101:99999999999999999999999",
])("malformed reserved ref %s is refused without URL or local fallback", async (bad) => {
  await withDiscordCli(async (f) => {
    writeFileSync(join(dirname(f.tmp), bad), "would be a local fallback");
    for (const command of ["transcribe", "download"]) {
      const args = command === "download" ? [command, bad, "--out", join(dirname(f.tmp), "never")] : [command, bad];
      const r = await f.invoke(args, { environment, routes: discordRoutes("voice.ogg", Buffer.alloc(1)) });
      expect([r.code, r.out, r.keys, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], [], []]);
    }
  });
});

test("a ./discord-file: path stays a local transcribe input", async () => {
  await withDiscordCli(async (f) => {
    writeFileSync(join(dirname(f.tmp), "discord-file:99:10:20:101:500"), "local reserved name");
    const r = await f.invoke(["transcribe", `./${ref}`], { environment });
    expect([r.code, r.err, r.out, r.keys]).toEqual([0, "", "local reserved name", []]);
  });
});

test("a plain URL still follows its redirect and reports only the status on HTTP errors", async () => {
  await withDiscordCli(async (f) => {
    const followed = await f.invoke(["transcribe", "https://cdn.example/start?token=private"], {
      routes: { "GET /start?token=private": { status: 302, location: "/audio/voice.ogg?token=private" } },
    });
    expect([followed.code, followed.err]).toEqual([0, ""]);
    expect(followed.keys).toEqual(["GET /start?token=private", "GET /audio/voice.ogg?token=private"]);
    const failed = await f.invoke(["transcribe", "https://user:pw@cdn.example/private/path?token=private"], {
      routes: { "GET /private/path?token=private": { status: 403 } },
    });
    expect([failed.code, failed.out]).toEqual([1, ""]);
    expect(failed.err).toContain("GET answered 403");
    for (const leaked of ["token=private", "/private/path", "user", "pw@"]) expect(failed.err).not.toContain(leaked);
  });
});

test("a Telegram token-in-path URL error never echoes the token", async () => {
  await withDiscordCli(async (f) => {
    const token = "123456:synthetic-telegram-token";
    const r = await f.invoke(["transcribe", `https://api.telegram.org/file/bot${token}/voice/file_1.oga`], {
      routes: { [`GET /file/bot${token}/voice/file_1.oga`]: { status: 404 } },
    });
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toContain("GET answered 404");
    expect(r.err).not.toContain("synthetic-telegram-token");
    expect(r.err).not.toContain("123456");
  });
});
