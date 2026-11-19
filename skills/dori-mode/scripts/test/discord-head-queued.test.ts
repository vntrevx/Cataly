import { expect, spyOn, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordSourceFingerprint } from "../src/messenger/discord-source-fingerprint.ts";
import { headEmitter, reconcileHead } from "../src/messenger/head-admission.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

const source = toInbound(ownerMessage("105"));
const original = {
  identity: "99:10:20:105",
  fingerprint: discordSourceFingerprint(source),
  headFile: "/head/original.jsonl",
  headPid: process.pid,
  source,
};

test("native intake preserves an older owner that upstream admitted before a newer cursor", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  try {
    queue.storeFor("20").save("102");
    queue.push("message", ownerMessage("105"), "102");
    queue.storeFor("20").save("107");
    const intake = await discordInbound(discordRestWorld([ownerMessage("107")]).discord, queue.storeFor, {
      ownerId: "10",
      channelIds: ["20"],
    });
    const received: string[] = [];
    const emit = headEmitter(queue, "99", "10", (message) => {
      received.push(message.message);
      return `INBOUND ${message.message}`;
    });
    await intake.accept(ownerMessage("105"), emit, queue.first()!.admittedAfter);
    expect(received).toEqual(["105"]);
    expect(queue.storeFor("20").load()).toBe("107");
    queue.acknowledge("20", "105");
    expect(queue.first()).toBeNull();
    await intake.accept(ownerMessage("105"), emit, "107");
    expect(received).toEqual(["105"]);
  } finally {
    stdout.mockRestore();
    queue.close();
    state.done();
  }
});

for (const outcome of ["accepted", "rejected"] as const)
  for (const checkpoint of [false, true])
    test(`${outcome} receipt survives ${checkpoint ? "cursor-to-ACK" : "receipt-to-cursor"} interruption for a late owner`, async () => {
      const state = withState();
      let queue = discordInboundQueue(state.dir, true);
      try {
        queue.storeFor("20").save("107");
        queue.push("message", ownerMessage("105"), "102");
        queue.push("message", ownerMessage("105", { channel_id: "21" }), "102");
        queue.attempt(original);
        queue.receipt(original.identity, outcome, "native-entry");
        if (checkpoint) queue.storeFor("20").save("107");
        queue.close();
        queue = discordInboundQueue(state.dir);
        await reconcileHead(queue);
        expect(queue.storeFor("20").load()).toBe("107");
        expect(queue.admission(original.identity, original.fingerprint)?.receipt).toBe("native-entry");
        const intake = await discordInbound(discordRestWorld([ownerMessage("107")]).discord, queue.storeFor, {
          ownerId: "10",
          channelIds: ["20"],
        });
        await intake.accept(
          ownerMessage("105"),
          headEmitter(queue, "99", "10", () => {
            throw new Error("a saved native receipt must not dispatch or print again");
          }),
          queue.first()!.admittedAfter,
        );
        expect(queue.storeFor("20").load()).toBe("107");
        queue.acknowledge("21", "105");
        expect(queue.admission(original.identity, original.fingerprint)?.receipt).toBe("native-entry");
        queue.acknowledge("20", "104");
        expect(queue.admission(original.identity, original.fingerprint)?.receipt).toBe("native-entry");
        queue.acknowledge("20", "105");
        expect(queue.first()).toBeNull();
        expect(queue.admission(original.identity, original.fingerprint)).toBeNull();
      } finally {
        queue.close();
        state.done();
      }
    });

test("an unknown native attempt also fences upstream exact-ID acknowledgement", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  try {
    queue.storeFor("20").save("102");
    queue.push("message", ownerMessage("105"), "102");
    queue.push("message", ownerMessage("106", { channel_id: "21" }), "102");
    queue.attempt(original);
    expect(() => queue.acknowledge("20", "105")).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(() => queue.acknowledge("21", "106")).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(queue.has("20", "105")).toBe(true);
    expect(queue.has("21", "106")).toBe(true);
    expect(queue.storeFor("20").load()).toBe("102");
  } finally {
    queue.close();
    state.done();
  }
});
