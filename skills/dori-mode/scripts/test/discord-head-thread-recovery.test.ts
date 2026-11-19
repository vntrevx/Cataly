import { expect, test } from "bun:test";
import { join } from "node:path";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordSourceFingerprint } from "../src/messenger/discord-source-fingerprint.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { queuedWorld, settle } from "./discord-inbound-live-fakes.ts";

test("native redelivery retains newly established parent provenance and the original FIFO record", async () => {
  const attachment = { filename: "owner.txt", size: 3, url: "https://cdn.discordapp.com/owner?ex=first" };
  const raw = ownerMessage("105", { channel_id: "50", attachments: [attachment] });
  const world = await queuedWorld({
    history: [ownerMessage("100")],
    messages: [raw],
    cursors: { "20": "100", "50": "102" },
    sync: false,
    nativeAdmission: true,
  });
  const original = world.queue().first()!;
  expect(original.parent).toBeNull();
  expect(() => world.queue().push("message", { ...raw, content: "conflicting body" }, "104", "20")).toThrow(
    "identity conflict",
  );
  expect(world.queue().parentFor("50")).toBeUndefined();
  world
    .queue()
    .push(
      "message",
      { ...raw, attachments: [{ ...attachment, url: "https://cdn.discordapp.com/owner?ex=renewed" }] },
      "104",
      "20",
    );
  world.queue().push("message", raw, "104");
  expect(world.queue().first()).toEqual({ ...original, parent: "20" });
  expect(world.queue().parentFor("50")).toBe("20");
  world.rest.state.failure.set("/channels/50", 404);
  world.rest.state.failure.set("/channels/50/messages", 403);
  const snapshots: string[] = [];
  const run = await world.restart((message) => {
    snapshots.push(message.attachments[0]!.url);
  });
  await settle();
  expect(world.received).toEqual(["50:105"]);
  expect(snapshots).toEqual([attachment.url]);
  expect(world.cursor("50")).toBe("105");
  expect(run.intake.channels()).toEqual(["20"]);
  expect(world.queue().first()).toBeNull();
  await world.restart();
  await settle();
  expect(world.received).toEqual(["50:105"]);
});

for (const sync of [false, true]) {
  for (const scope of ["threads-disabled", "parent-unwatched"] as const) {
    test(`scope change ${scope} cannot discard an unknown native attempt behind a ${sync ? "sync" : "message"} prefix`, async () => {
      const raw = ownerMessage("105", { channel_id: "50" });
      const world = await queuedWorld({
        history: [ownerMessage("100")],
        messages: [raw],
        cursors: { "20": "100", "21": "100", "50": "102" },
        parents: { "50": "20" },
        options: {
          ownerId: "10",
          channelIds: scope === "parent-unwatched" ? ["21"] : ["20"],
          threads: scope !== "threads-disabled",
        },
        sync,
        nativeAdmission: true,
      });
      const source = toInbound(raw);
      world.queue().attempt({
        identity: "99:10:50:105",
        fingerprint: discordSourceFingerprint(source),
        headFile: join(world.dir, "unconfirmed-native.jsonl"),
        headPid: process.pid,
        source,
      });
      const original = world.queue().unresolved();
      const run = await world.restart();
      expect(await run.outcome).toMatchObject({ code: "HEAD_ADMISSION_UNRESOLVED" });
      expect(world.received).toEqual([]);
      expect(world.queue().unresolved()).toEqual(original);
      expect(world.queue().has("50", "105")).toBe(true);
      expect(world.queue().nextOwner("50", "10", "105", "0", 0)?.payload).toBe(JSON.stringify(raw));
      expect(world.queue().parentFor("50")).toBe("20");
      expect(world.cursor("50")).toBe("102");
      expect(world.cursor("20")).toBe("100");
      expect(world.cursor("21")).toBe("100");
    });
  }
}
