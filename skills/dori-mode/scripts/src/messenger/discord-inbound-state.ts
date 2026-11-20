import { join } from "node:path";
import { MessengerError } from "./http.ts";
import { privateStateFile } from "./private-state-file.ts";

export type DiscordInboundStore = { load(): string | undefined; save(cursor: string): void };

export const isDiscordSnowflake = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;

export const discordInboundEnv = (name: string, value: string | undefined): string => {
  const id = value?.trim();
  if (!isDiscordSnowflake(id)) throw new MessengerError(`${name} must be a positive decimal Discord ID`, 0);
  return id;
};

export const fileDiscordInboundStore = (stateDir: string, channelId: string): DiscordInboundStore => {
  if (!isDiscordSnowflake(channelId)) throw new MessengerError("Discord inbound channel ID is invalid", 0);
  const file = privateStateFile(join(stateDir, "discord-inbound"), channelId, "Discord inbound cursor");
  return {
    load() {
      try {
        const raw = file.read();
        if (raw === undefined) return undefined;
        const state = JSON.parse(raw) as { version?: number; channelId?: string; cursor?: string };
        if (
          !state ||
          state.version !== 1 ||
          state.channelId !== channelId ||
          (state.cursor !== "0" && !isDiscordSnowflake(state.cursor))
        )
          throw new MessengerError("Discord inbound cursor state is invalid; repair it before restarting intake", 0);
        return state.cursor;
      } catch (error) {
        if (error instanceof MessengerError) throw error;
        throw new MessengerError("Discord inbound cursor state is invalid; repair it before restarting intake", 0);
      }
    },
    save(cursor) {
      if (cursor !== "0" && !isDiscordSnowflake(cursor))
        throw new MessengerError("Discord inbound cursor is invalid", 0);
      file.write(`${JSON.stringify({ version: 1, channelId, cursor })}\n`);
    },
  };
};
