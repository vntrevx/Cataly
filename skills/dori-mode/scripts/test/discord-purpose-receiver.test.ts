import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

test("shared inbound settings preserve the receiver channel set across duplicate singular and plural IDs", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
    const probe = join(state.dir, "receiver-probe.mjs");
    writeFileSync(
      probe,
      [
        `import { discordAskReceivers } from ${JSON.stringify(join(import.meta.dir, "../src/messenger/discord-ask-receiver.ts"))};`,
        "const originalFetch = globalThis.fetch;",
        "globalThis.fetch = async (input, init) => {",
        "  const url = new URL(String(input));",
        '  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/channels/30")',
        '    return new Response("{}", { status: 200 });',
        '  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/channels/30/messages")',
        '    return new Response("[]", { status: 200 });',
        "  return await originalFetch(input, init);",
        "};",
        "const originalSleep = Bun.sleep;",
        'Object.defineProperty(Bun, "sleep", { value: async (ms) => {',
        "  const scopes = discordAskReceivers(process.env.DORI_STATE_DIR, process.env.DORI_DISCORD_TOKEN);",
        '  console.log("DISCORD_ASK_SCOPE_QA " + JSON.stringify(scopes));',
        "  await originalSleep(ms);",
        "} });",
      ].join("\n"),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-discord-inbound.ts"),
        "--preload",
        probe,
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        "--loop",
        "0.05",
      ],
      {
        env: {
          HOME: state.dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_STATE_DIR: state.dir,
          DORI_DISCORD_TOKEN: "synthetic-inbound-token",
          DORI_DISCORD_OWNER_ID: "10",
          DORI_DISCORD_CHANNEL_ID: " 20, 30,20 ",
          DORI_DISCORD_CHANNEL_IDS: "30, 20, 30",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out.trim().split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20,30 bot=99");
    const prefix = "DISCORD_ASK_SCOPE_QA ";
    const scopes = out
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
    const expected = [{ owner: "10", explicit: ["20", "30"], watched: ["20", "30"] }];
    expect(scopes).toEqual([expected, expected]);
    expect(out).not.toContain("synthetic-inbound-token");
  } finally {
    state.done();
  }
});
