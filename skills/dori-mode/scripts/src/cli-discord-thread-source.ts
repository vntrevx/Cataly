import { createHash } from "node:crypto";
import type { Command } from "./cli-context.ts";
import { tagIds } from "./cli-discord-ops.ts";
import { threadSourcePlan } from "./cli-discord-thread-plan.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type DcChannel, isForumType } from "./messenger/discord.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import {
  DiscordThreadReceipts,
  type ThreadAttempt,
  type ThreadPatch,
  threadSourceKey,
} from "./messenger/discord-thread-receipts.ts";
import { DeliveryUncertainError, MessengerError } from "./messenger/http.ts";

const fail = (message: string) => new MessengerError(message, 400);
const held = (attempt: ThreadAttempt) =>
  new MessengerError(
    `Discord thread operation is held for its original source/lane${attempt.thread === undefined ? "" : `; thread ${attempt.thread} exists`}. Inspect the receipt and actual thread; do not recreate.`,
    0,
  );
const printReceipt = (attempt: ThreadAttempt) => {
  console.log(`THREAD ${attempt.thread}${attempt.message === undefined ? "" : ` mid=${attempt.message}`}`);
};

export const sourceThreadDiscord: Command = async (cli) => {
  const { config, deps } = cli;
  const { action, lane, target, message, name, text, tags, archived, dc, origin, parent, parentId } =
    await threadSourcePlan(cli);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ action, target, name, text, tags, message, archived }))
    .digest("hex");
  const result = await withDeliveryLock(
    deps,
    "@discord-threads",
    async () => {
      const store = new DiscordThreadReceipts(config.stateDir);
      const attempts = store.read();
      const source = threadSourceKey(origin.identity);
      const index = attempts.findIndex(
        (entry) =>
          entry.kind === action &&
          threadSourceKey(entry.source) === source &&
          (action === "create" || entry.thread === target),
      );
      const previous = attempts[index];
      const registered = await deps.registry.read(lane);
      if (
        action === "set"
          ? registered?.thread !== `discord:${target}`
          : registered !== null &&
            (previous?.thread === undefined || registered.thread !== `discord:${previous.thread}`)
      )
        throw fail("lane is not bound to this original thread, or the fresh create lane is already registered");
      if (previous !== undefined) {
        if (previous.source.botId !== origin.identity.botId || previous.source.ownerId !== origin.identity.ownerId)
          throw fail("original thread source identity changed; keep its receipt and do not recreate");
        if (previous.lane !== lane || previous.parent !== parentId || previous.fingerprint !== fingerprint)
          throw fail("original thread source/lane already has a different operation; do not recreate");
        if (previous.state === "confirmed") return printReceipt(previous);
        throw held(previous);
      }
      if (action === "create" && attempts.some((entry) => entry.kind === "create" && entry.lane === lane))
        throw fail("lane already has an original thread creation receipt; do not recreate");
      if (tags.length > 0) {
        if (!isForumType(parent.type)) throw fail("--tag needs a forum post");
        for (const tag of tags) {
          const matches =
            parent.available_tags?.filter((available) => available.id === tag || available.name === tag) ?? [];
          if (matches.length !== 1 || !isDiscordSnowflake(matches[0]?.id))
            throw fail(`tag ${JSON.stringify(tag)} must match exactly one available forum tag`);
        }
      }
      if (action === "create" && isForumType(parent.type) && ((parent.flags ?? 0) & 16) !== 0 && tags.length === 0)
        throw fail("forum requires an explicit available --tag; no tag was guessed");
      const appliedTags = tags.length > 0 ? tagIds(parent, tags) : undefined;
      const patch: ThreadPatch = {
        ...(name === undefined ? {} : { name }),
        ...(appliedTags === undefined ? {} : { appliedTags }),
        ...(archived === undefined ? {} : { archived }),
      };
      let attempt: ThreadAttempt = {
        kind: action,
        source: origin.identity,
        lane,
        parent: parentId,
        fingerprint,
        at: deps.clock.now(),
        state: "pending",
        ...(action === "set" ? { thread: target, patch } : {}),
      };
      const slot = attempts.length;
      const save = (next: ThreadAttempt) => {
        attempts[slot] = next;
        attempt = next;
        store.write(attempts);
      };
      save(attempt);
      try {
        if (action === "set") {
          const id = await dc.setThread(target, patch);
          if (id !== target) throw new DeliveryUncertainError("Discord thread update returned another target ID", 200);
          save({ ...attempt, state: "confirmed" });
        } else {
          const created = async (createdThread: DcChannel) => {
            const expectedType = parent.type === 5 ? 10 : 11;
            if (
              !isDiscordSnowflake(createdThread.id) ||
              createdThread.id === origin.channel.id ||
              createdThread.id === parentId ||
              createdThread.parent_id !== parentId ||
              createdThread.owner_id !== origin.identity.botId ||
              createdThread.type !== expectedType ||
              (message !== undefined && createdThread.id !== message) ||
              attempts.some(
                (entry, other) => other !== slot && entry.kind === "create" && entry.thread === createdThread.id,
              )
            ) {
              if (isDiscordSnowflake(createdThread.id)) save({ ...attempt, candidate: createdThread.id });
              throw new DeliveryUncertainError("Discord thread creation returned an unconfirmed identity", 200);
            }
            save({
              ...attempt,
              state: "created",
              thread: createdThread.id,
              ...(isForumType(parent.type) && isDiscordSnowflake(createdThread.message?.id)
                ? { message: createdThread.message.id }
                : {}),
            });
            const current = await deps.registry.read(lane);
            if (current !== null && current.thread !== `discord:${createdThread.id}`) throw held(attempt);
            if (isForumType(parent.type) && !isDiscordSnowflake(createdThread.message?.id))
              throw new DeliveryUncertainError("Discord forum starter has no confirmed message ID", 200);
          };
          // name was checked before any request; the existing SDK still performs every create and split send.
          const receipt =
            message === undefined
              ? await dc.createThread(parent, name as string, {
                  ...(typeof text === "string" ? { text } : {}),
                  ...(appliedTags === undefined ? {} : { appliedTags }),
                  created,
                })
              : await dc.threadOnMessage(
                  parentId,
                  message,
                  name as string,
                  typeof text === "string" ? text : undefined,
                  created,
                );
          if (
            receipt.id !== attempt.thread ||
            (receipt.messageId !== undefined && !isDiscordSnowflake(receipt.messageId))
          )
            throw new DeliveryUncertainError("Discord thread completion has no confirmed receipt", 200);
          save({
            ...attempt,
            state: "confirmed",
            ...(receipt.messageId === undefined ? {} : { message: receipt.messageId }),
          });
        }
      } catch (error) {
        if (
          attempt.state === "pending" &&
          error instanceof MessengerError &&
          error.outcome === "rejected" &&
          error.status >= 400 &&
          error.status < 500
        ) {
          attempts.splice(slot, 1);
          store.write(attempts);
          throw error;
        }
        if (action === "create" && attempt.thread !== undefined) {
          const completion =
            attempt.state === "confirmed" ? "completion receipt could not be saved" : "completion is unconfirmed";
          throw new DeliveryUncertainError(
            `${error instanceof Error ? error.message : String(error)}; thread ${attempt.thread} exists but ${completion}; keep its original source/lane and do not recreate`,
            0,
          );
        }
        throw error;
      }
      printReceipt(attempt);
    },
    0,
  );
  if (!result.ok) throw fail("another source-bound thread operation holds the receipt lock; no mutation was attempted");
};
