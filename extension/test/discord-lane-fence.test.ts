import { expect, test } from "bun:test";
import { DeliveryState } from "../../skills/dori-mode/scripts/src/delivery-state.ts";
import { openDiscordLaneInbox } from "../../skills/dori-mode/scripts/src/messenger/discord-lane-inbox.ts";
import type { Lane } from "../../skills/dori-mode/scripts/src/registry.ts";
import { realClock } from "../../skills/dori-mode/scripts/src/run.ts";
import { tellLane } from "../../skills/dori-mode/scripts/src/tell.ts";
import { depsFor, laneState, newWorld, withState } from "../../skills/dori-mode/scripts/test/fakes.ts";
import { DiscordLane } from "../discord-lane.ts";
import { fakePi, until } from "./fake-pi.ts";

test("direct owner input preserves native admission without releasing an uncertain automation fence", async () => {
  const state = withState();
  const world = newWorld();
  const deps = depsFor(world, realClock, state.dir);
  const ref = { runtime: "herdr", id: "w1:p2" } as const;
  const session = "owner-input-session";
  const channel = "109867692300000023";
  const message = "109867692300000024";
  const at = new Date().toISOString();
  const lane: Lane = {
    key: "owner-input",
    title: "Owner input",
    thread: `discord:${channel}`,
    sessionRef: ref,
    session,
    status: "working",
    brief: "owner input regression",
    done: "owner input delivered; automation held",
    openedAt: at,
  };
  const delivery = new DeliveryState(deps.registry, lane.key);
  const record = { id: crypto.randomUUID(), openedAt: at, session: ref, at, status: "uncertain" } as const;
  const inbox = openDiscordLaneInbox(state.dir);
  const native = new DiscordLane();
  const pi = fakePi({ mode: "tui", session: { id: session, entries: [] } });
  const before = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  try {
    delete process.env.HC_TERMINAL_ID;
    process.env.HERDR_PANE_ID = ref.id;
    await deps.registry.write(lane);
    laneState(state.dir, ref.id, { pid: process.pid, sessionId: session, discordLaneInbox: true });
    delivery.write(record);
    inbox.add(session, {
      channel,
      message,
      text: "owner follow-up",
      reference: null,
      replyTo: null,
      attachments: [],
    });

    native.start(pi.api, state.dir, pi.ctx(), { key: lane.key, sessionId: session }, false, () => true);
    await until(() => pi.messages.length === 1);
    expect(pi.messages).toEqual([
      {
        content: `[discord] INBOUND discord ${channel} ${message} from=owner ref=- "owner follow-up"`,
        options: { triggerTurn: true, deliverAs: "aside" },
      },
    ]);
    const followUp = await tellLane(deps, lane, "automated follow-up");
    expect(followUp.code).toBe(2);
    expect(followUp.line).toContain(`TELL_HELD ${lane.key} delivery=held: request=${record.id}`);
    expect(world.calls).toEqual([]);
    expect(delivery.read()).toEqual(record);
    expect(pi.messages).toHaveLength(1);
  } finally {
    native.stop();
    inbox.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    state.done();
  }
}, 8000);
