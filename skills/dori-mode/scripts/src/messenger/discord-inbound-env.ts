import type { DiscordInboundOptions } from "./discord-inbound.ts";
import { discordInboundEnv } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

/** Intake and attachment reads use the same explicit channels, thread policy and owner. */
export const discordInboundOptions = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): DiscordInboundOptions => {
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
  const scope = env["DORI_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all")
    throw new MessengerError("DORI_DISCORD_SCOPE must be all or unset", 0);
  const all = scope === "all";
  const setting = env["DORI_DISCORD_THREADS"]?.trim().toLowerCase();
  if (setting !== undefined && setting !== "" && setting !== "off" && setting !== "on")
    throw new MessengerError("DORI_DISCORD_THREADS must be on, off or unset", 0);
  const channelIds = ["DORI_DISCORD_CHANNEL_ID", "DORI_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    (env[name] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "")
      .map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("DORI_DISCORD_CHANNEL_ID", env["DORI_DISCORD_CHANNEL_ID"]);
  return { ownerId, channelIds: [...new Set(channelIds)], all, threads: setting !== "off" };
};
