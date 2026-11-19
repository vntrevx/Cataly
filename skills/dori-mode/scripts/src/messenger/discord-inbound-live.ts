import { discordGateway, type GatewayClock, type GatewaySocket } from "./discord-gateway.ts";
import { type Emit, isTransient, type Message } from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";
import { discordThreadAdmission, type ThreadIntake } from "./discord-inbound-thread-admission.ts";

const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15;

type Intake = ThreadIntake & {
  accepts(message: Message, parent?: string | null): boolean;
  sync(emit: Emit, queue?: DiscordInboundQueue, scoped?: () => void): Promise<void>;
  accept(message: Message, emit: Emit, after?: string | null, parent?: string | null): void | Promise<void>;
};

export type DiscordInboundLive = { done: Promise<void>; close(): void };

/**
 * Scoped dispatches and backfills share the durable FIFO. Unknown thread scope is resolved in bounded RAM
 * before payload admission; those candidates do not have the admitted queue's crash/deletion recovery guarantee.
 */
export const discordInboundLive = (
  intake: Intake,
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  emit: Emit,
  report: (line: string) => void,
  queue: DiscordInboundQueue,
  activity?: { received(message: Message): void; healthy(): void; unavailable(): void },
): DiscordInboundLive => {
  const admission = new AbortController();
  const cancelled = new Error("Discord inbound closed before ledger admission");
  const deliver: Emit = (message) => emit(message, admission.signal);
  let running = Promise.resolve();
  let recover = queue.first()?.kind === "message";
  let draining = false;
  let failure: unknown;
  let dead = false;
  let synced = false;
  let connected = false;
  let connection = 0;
  let gateway: ReturnType<typeof discordGateway> | undefined;
  const fail = (error: unknown) => {
    failure ??= error;
    dead = true; // Preserve every committed record and its admission position.
    close();
  };
  const observe = (action: () => void): void => {
    if (dead) return;
    try {
      action();
    } catch (error) {
      fail(error);
    }
  };
  let timer: unknown;
  let wake: (() => void) | undefined;
  const pause = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    wake = resolve;
    timer = clock.setTimeout(resolve, ms);
    return promise;
  };
  const backfill = async () => {
    const generation = connection;
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        await intake.sync(deliver, queue, metadata.flushKnown);
        if (!dead && connected && generation === connection) {
          synced = true;
          if (!metadata.pending()) activity?.healthy();
        }
        return;
      } catch (error) {
        if (dead || !isTransient(error)) throw error;
        report(`DISCORD_GATEWAY_BACKFILL_RETRY discord retry_in=${delay / 1000}s`);
        await pause(delay);
        if (dead) return;
      }
    }
  };
  const drain = () => {
    if (draining || dead) return;
    draining = true;
    running = (async () => {
      try {
        if (recover) {
          recover = false;
          await backfill();
        }
        for (let job = queue.first(); job && !dead; job = queue.first()) {
          if (job.kind === "sync") {
            await backfill();
            if (!dead) queue.remove(job.id);
          } else {
            job = queue.before(job.id) ?? job;
            const message = JSON.parse(job.payload) as Message;
            await intake.accept(message, deliver, job.admittedAfter, job.parent);
            if (!dead) {
              if (intake.accepts(message, job.parent)) queue.acknowledge(message.channel_id, message.id);
              else queue.remove(job.id);
            }
          }
        }
      } catch (error) {
        if (error !== cancelled || !admission.signal.aborted) fail(error);
      } finally {
        draining = false;
      }
    })();
  };
  const enqueue = (kind: "sync" | "message", data?: Message, after?: string, parent?: string) => {
    if (dead) return;
    if (kind === "message" && data) {
      after ??= intake.cursorFor(data.channel_id);
      parent ??= intake.parentFor?.(data.channel_id);
    }
    queue.push(kind, data, after, parent);
    if (kind === "message" && data) observe(() => activity?.received(data));
    drain(); // Persist first; each caller owns propagation of a storage failure.
  };
  const metadata = discordThreadAdmission(
    intake,
    clock,
    (message, after, parent) => enqueue("message", message, after, parent),
    report,
    fail,
  );
  // Defined before the Gateway exists: a synchronous connect failure can already report health and fail.
  const close = () => {
    observe(() => activity?.unavailable());
    admission.abort(cancelled);
    dead = true;
    connection++;
    metadata.close();
    if (timer !== undefined) clock.clearTimeout(timer);
    wake?.();
    gateway?.close();
  };
  gateway = discordGateway(open, token, clock, report, {
    label: "DISCORD_GATEWAY",
    intents: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT,
    online: false,
    onReady: () => {
      connection++;
      connected = true;
      synced = false;
      observe(() => activity?.unavailable());
      try {
        enqueue("sync");
      } catch (error) {
        fail(error);
      }
    },
    onHealth: (available) => {
      if (!available) {
        connection++;
        connected = synced = false;
        observe(() => activity?.unavailable());
      } else if (synced)
        observe(() => {
          // Volatile thread candidates are lost on close, so they block health like undelivered durable work.
          if (!queue.first() && !metadata.pending()) activity?.healthy();
        });
    },
    onDispatch: (type, data) => {
      if (dead || type !== "MESSAGE_CREATE") return;
      try {
        const message = data as Message;
        if (intake.accepts(message)) enqueue("message", message);
        else if (metadata.push(message)) observe(() => activity?.received(message));
      } catch (error) {
        fail(error);
      }
    },
  });
  if (dead) gateway.close();
  const done = gateway.done.finally(async () => {
    close();
    await metadata.done();
    await running;
    if (failure !== undefined) throw failure;
  });
  drain();
  return { done, close };
};
