import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withState } from "./fakes.ts";

for (const platform of ["discord", "slack"])
  test(`${platform} REST exits nonzero when its required activity writer fails`, async () => {
    const state = withState();
    try {
      const config = join(state.dir, "config.json");
      const activity = join(state.dir, "activity.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-inbound-activity-failure.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          "inbound",
          platform,
          "--loop",
          "0",
          "--activity-file",
          activity,
        ],
        {
          env: {
            HOME: state.dir,
            PATH: "/usr/bin:/bin",
            DORI_CONFIG: config,
            DORI_STATE_DIR: state.dir,
            DORI_TEST_PLATFORM: platform,
            DORI_TEST_ACTIVITY: activity,
            DORI_DISCORD_TOKEN: "synthetic-inbound-token",
            DORI_DISCORD_OWNER_ID: "10",
            DORI_DISCORD_CHANNEL_ID: "20",
            DORI_SLACK_TOKEN: "synthetic-slack-token",
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
      expect(code).toBe(1);
      expect(err).toContain("Inbound activity");
      expect(out).not.toContain("WARN");
      expect(out).not.toContain("INBOUND discord ");
      expect(out).not.toContain("INBOUND own-thread ");
      expect(out + err).not.toMatch(/synthetic-inbound-token|synthetic-slack-token/);
      if (platform === "discord") expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("100");
      expect(existsSync(activity + ".lock/owner.json")).toBe(false);
    } finally {
      state.done();
    }
  });
