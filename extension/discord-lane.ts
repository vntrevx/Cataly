import { existsSync } from "node:fs";
import { join } from "node:path";
import { withDeliveryLock } from "../skills/dori-mode/scripts/src/delivery-lock.ts";
import { readPaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { routeDiscordAskReply } from "../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import {
  type DiscordAskReceiverPublication,
  discordAskReceivers,
  openDiscordAskReceiver,
} from "../skills/dori-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { discordInbound } from "../skills/dori-mode/scripts/src/messenger/discord-inbound.ts";
import { discordInboundQueue } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-queue.ts";
import {
  discordLaneTarget,
  openDiscordLaneInbox,
  uniqueDiscordLane,
} from "../skills/dori-mode/scripts/src/messenger/discord-lane-inbox.ts";
import { Discord } from "../skills/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "../skills/dori-mode/scripts/src/messenger/http.ts";
import { Registry, statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { realClock } from "../skills/dori-mode/scripts/src/run.ts";
import { discordAskToken, routeFor } from "./discord-ask.ts";
import { type AskLane, laneChannel } from "./discord-ask-auto.ts";
import type { DoriApi, DoriContext } from "./index.ts";

const POLL_MS = 3_000;
const PREFIX = "[discord] ";

/** Lane intake belongs to the foreground OMP session rather than its terminal or the lead's model. */
export class DiscordLane {
  private stopLoop?: () => void;

  stop(): void {
    this.stopLoop?.();
    this.stopLoop = undefined;
  }

  start(
    pi: DoriApi,
    root: string,
    ctx: DoriContext,
    binding: AskLane | undefined,
    dedicated: boolean,
    idle: () => boolean,
  ): void {
    this.stop();
    if (ctx.mode !== "tui") return;
    const paneId = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
    if (!paneId) return;
    const session = ctx.sessionManager.getSessionId();
    const lifecycle = new AbortController();
    const delivery = { registry: new Registry(root), clock: realClock };
    const { signal } = lifecycle;
    const ownsPane = () => {
      if (signal.aborted || ctx.sessionManager.getSessionId() !== session) return false;
      const state = readPaneState(root, paneId);
      return state?.role === "lane" && state.pid === process.pid && state.sessionId === session;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inbox: ReturnType<typeof openDiscordLaneInbox> | undefined;
    let rootInbox: ReturnType<typeof openDiscordLaneInbox> | undefined;
    let intake: Awaited<ReturnType<typeof discordInbound>> | undefined;
    let queue: ReturnType<typeof discordInboundQueue> | undefined;
    let receiver: DiscordAskReceiverPublication | undefined;
    let isolatedRoute: string | undefined;
    let confirm: (() => boolean) | undefined;
    let warned = false;
    this.stopLoop = () => {
      lifecycle.abort();
      clearTimeout(timer);
      receiver?.close();
      queue?.close();
      inbox?.close();
      rootInbox?.close();
    };

    const delivered = (text: string) =>
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) => entry.type === "custom_message" && entry.customType === "dori-monitor" && entry.content === text,
        );

    const drain = async (source: ReturnType<typeof openDiscordLaneInbox>, channel: string, key: string) => {
      const message = source.next(session, channel);
      if (!message) return;
      const text = PREFIX + message.text;
      if (delivered(text)) source.acknowledge(session, channel, message.id);
      else {
        await withDeliveryLock(
          delivery,
          key,
          async () => {
            const current = await delivery.registry.read(key);
            if (!current || statusOf(current) === "closed" || statusOf(current) === "paused") return;
            if (!dedicated && (await discordLaneTarget(root, channel))?.session !== session) return;
            if (confirm || !idle() || ctx.isIdle?.() === false || !ownsPane()) return;
            pi.sendMessage(
              { customType: "dori-monitor", content: text, display: true },
              { triggerTurn: true, deliverAs: "aside" },
            );
            confirm = () => {
              if (!delivered(text)) return false;
              source.acknowledge(session, channel, message.id);
              return true;
            };
          },
          0,
        );
      }
    };

    const run = async (): Promise<void> => {
      if (!ownsPane()) return;
      try {
        if (confirm?.()) confirm = undefined;
        // A manually bound session can already name a separate receiver root. Reuse that exact connection,
        // but never start another Discord poller for the shared receiver or for an ASK-only opt-out.
        const explicit = dedicated ? routeFor(root, session) : undefined;
        const routeKey = explicit && explicit.receiverStateDir !== root ? JSON.stringify(explicit) : undefined;
        if (routeKey !== isolatedRoute) {
          // A changed connection may not drain the old connection's messages into this lane.
          if (confirm) return;
          inbox?.close();
          inbox = undefined;
          intake = undefined;
          queue?.close();
          queue = undefined;
          receiver?.close();
          receiver = undefined;
          isolatedRoute = routeKey;
        }
        if (explicit && explicit.receiverStateDir !== root) {
          const stateDir = explicit.receiverStateDir;
          const lane = await uniqueDiscordLane(root, (entry) => entry.sessionRef?.id === paneId, true);
          if (!lane || (lane.session !== undefined && lane.session !== session) || !ownsPane()) return;
          const token = discordAskToken(explicit);
          if (
            discordAskReceivers(root, token).some(
              (item) => item.owner === explicit.owner && item.watched.includes(explicit.channel),
            )
          )
            throw new Error("The shared Discord receiver already owns this lane channel");
          if (!intake) {
            queue ??= discordInboundQueue(stateDir);
            if (queue.first()) throw new Error("Complete pending Gateway intake before taking over this receiver");
            const discord = new Discord(
              (request) =>
                fetchHttp({
                  ...request,
                  signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(10_000),
                    ...(request.signal ? [request.signal] : []),
                  ]),
                }),
              realClock,
              token,
            );
            intake = await discordInbound(discord, queue.storeFor, {
              ownerId: explicit.owner,
              channelIds: [explicit.channel],
              threads: false,
            });
            if (!ownsPane()) return;
            receiver = openDiscordAskReceiver(
              stateDir,
              token,
              explicit.owner,
              [explicit.channel],
              intake.channels,
              15_000,
            );
          }
          if (!ownsPane()) return;
          const receiverInbox = inbox ?? openDiscordLaneInbox(stateDir);
          inbox = receiverInbox;
          await intake.poll(async (message) => {
            signal.throwIfAborted();
            if (routeDiscordAskReply(stateDir, message, explicit.owner)) return;
            const held = await withDeliveryLock(delivery, lane.key, async () => {
              signal.throwIfAborted();
              const current = await delivery.registry.read(lane.key);
              if (!current || statusOf(current) === "closed" || !ownsPane())
                throw new Error("The dedicated Discord lane changed; cursor not advanced");
              receiverInbox.add(session, message);
            });
            if (!held.ok) throw new Error("Discord lane delivery is locked; cursor not advanced");
          });
          if (!ownsPane()) return;
          receiver?.refresh();
          await drain(inbox, explicit.channel, lane.key);
        } else if (existsSync(join(root, "discord-lanes", "inbox.sqlite"))) {
          const channel = await laneChannel(root, session, binding);
          const target = channel ? await discordLaneTarget(root, channel) : undefined;
          if (target?.session === session && channel && ownsPane()) {
            rootInbox ??= openDiscordLaneInbox(root);
            await drain(rootInbox, channel, target.key);
          }
        }
        warned = false;
      } catch {
        receiver?.suspend();
        if (!signal.aborted && !warned)
          ctx.ui.notify("Discord lane intake is unavailable; pending messages remain queued.", "warning");
        warned = true;
      } finally {
        if (!signal.aborted) timer = setTimeout(() => void run(), POLL_MS).unref();
      }
    };
    timer = setTimeout(() => void run(), 0).unref();
  }
}
