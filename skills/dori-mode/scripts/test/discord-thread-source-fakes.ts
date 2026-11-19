import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Registry } from "../src/registry.ts";
import { type DiscordRoute, ids } from "./discord-fakes.ts";

/** Source-bound thread CLI scenarios: bot 99, owner 7, source forum 30, original owner message 35. */
export const bot = "99";
export const owner = "7";
export const origin = "35";
export const lane = "source-task";
export const source = `discord ${ids.forum} ${origin}`;
export const environment = { DORI_DISCORD_OWNER_ID: owner, DORI_DISCORD_CHANNEL_ID: ids.forum };

export const tags = [
  { id: ids.working, name: "working" },
  { id: ids.done, name: "done" },
];
/** REQUIRE_TAG (flags 16) forum: a source-bound post must name one exact tag. */
export const forum = { id: ids.forum, type: 15, name: "tasks", flags: 16, available_tags: tags };
export const ownerMessage = (channel: string, id = origin) => ({
  id,
  channel_id: channel,
  type: 0,
  author: { id: owner },
  content: "open a thread for this",
});
/** A created thread that names its exact parent, the current bot as owner and a thread type. */
export const created = (parent: string, extra: Record<string, unknown> = {}, id: string = ids.thread) => ({
  id,
  type: 11,
  parent_id: parent,
  owner_id: bot,
  ...extra,
});
export const forumCreated = created(ids.forum, { message: { id: ids.starter, channel_id: ids.thread } });

export const routes: Record<string, DiscordRoute> = {
  "GET /users/@me": { body: { id: bot } },
  [`GET /channels/${ids.forum}`]: { body: forum },
  [`GET /channels/${ids.forum}/messages/${origin}`]: { body: ownerMessage(ids.forum) },
  [`POST /channels/${ids.forum}/threads`]: { body: forumCreated },
  [`GET /channels/${ids.thread}`]: { body: { id: ids.thread, type: 11, parent_id: ids.forum, name: "task" } },
  [`PATCH /channels/${ids.thread}`]: { body: { id: ids.thread } },
};

/** The routes and child environment of one CLI invocation. */
export type SourceScenario = {
  readonly routes: Record<string, DiscordRoute>;
  readonly environment: Record<string, string | undefined>;
};

export const options = (
  override: Record<string, DiscordRoute> = {},
  env: Record<string, string | undefined> = environment,
): SourceScenario => ({ environment: env, routes: { ...routes, ...override } });

/** A source-bound create in `to`; by default the source is message 35 of that same channel. */
export const createIn = (
  to: string,
  extra: readonly string[] = [],
  from = `discord ${to} ${origin}`,
  key: string | null = lane,
): string[] => [
  "thread",
  "discord",
  "create",
  "--to",
  to,
  "--title",
  "task",
  ...extra,
  "--source",
  from,
  ...(key === null ? [] : ["--lane", key]),
];

/** The default tagged forum create: `thread discord create --to 30 --title task --tag working --source ... --lane`. */
export const create = (extra: readonly string[] = [], from = source, key: string | null = lane): string[] =>
  createIn(ids.forum, ["--tag", "working", ...extra], from, key);

export const set = (target: string, patch: readonly string[], from = source, key: string | null = lane): string[] => [
  "thread",
  "discord",
  "set",
  target,
  ...patch,
  "--source",
  from,
  ...(key === null ? [] : ["--lane", key]),
];

/** Every non-GET request: a refused or replayed source-bound command makes none. */
export const mutations = (keys: readonly string[]): string[] => keys.filter((key) => !key.startsWith("GET "));

/** withDiscordCli keeps its config state one level above `tmp`; every child CLI shares it. */
export const stateOf = (fixture: { readonly tmp: string }): string => dirname(fixture.tmp);
export const receiptPath = (fixture: { readonly tmp: string }): string =>
  join(stateOf(fixture), "discord-threads.json");
export const receiptBytes = (fixture: { readonly tmp: string }): string | null =>
  existsSync(receiptPath(fixture)) ? readFileSync(receiptPath(fixture), "utf8") : null;
export const receiptMode = (fixture: { readonly tmp: string }): number => statSync(receiptPath(fixture)).mode & 0o777;

/** A registered lane record as launch writes it; `thread` is the exact `discord:<id>` binding. */
export const register = async (
  fixture: { readonly tmp: string },
  key: string,
  thread: string,
  closed = false,
): Promise<void> =>
  await new Registry(stateOf(fixture)).write({
    key,
    title: key,
    thread,
    brief: "brief.md",
    done: "done",
    openedAt: "2026-11-19T00:00:00.000Z",
    ...(closed ? { status: "closed" as const, closedAt: "2026-11-19T01:00:00.000Z" } : {}),
  });

/** Refusals and pending outcomes never suggest a bypass through a new key, source or manual command. */
export const bypassAdvice = /new (lane )?key|another (lane|key|source)|different (lane|key|source)|without --source/i;
