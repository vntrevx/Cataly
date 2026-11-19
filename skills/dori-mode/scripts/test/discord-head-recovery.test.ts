import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { every } from "../src/cli-context.ts";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { headEmitter, reconcileHead } from "../src/messenger/head-admission.ts";
import { type HeadAttempt, headUnresolved } from "../src/messenger/head-admission-state.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

const input = (headPid = process.pid): HeadAttempt => ({
  identity: "99:10:20:101",
  fingerprint: "a".repeat(64),
  headFile: "/head/original.jsonl",
  headPid,
  source: toInbound(ownerMessage("101")),
});

test("a deleted owner source also fences non-owner cursor updates and empty sync removal", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  try {
    const store = queue.storeFor("20");
    store.save("100");
    queue.push("sync", {});
    const world = discordRestWorld([ownerMessage("102", { author: { id: "11" } })]);
    const intake = await discordInbound(world.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
    queue.attempt(input());
    await expect(
      intake.poll(() => {
        throw new Error("non-owner input must not emit");
      }),
    ).rejects.toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(store.load()).toBe("100");
    world.state.messages = [];
    await intake.poll(() => {
      throw new Error("empty history must not emit");
    });
    expect(() => queue.remove(queue.first()!.id)).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(queue.first()?.kind).toBe("sync");
    expect(queue.unresolved()?.source).toBe(JSON.stringify(input().source));
    expect(() => queue.storeFor("21").save("200")).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(() => queue.attempt({ ...input(), identity: "99:10:21:202" })).toThrow("HEAD_ADMISSION_UNRESOLVED");
  } finally {
    queue.close();
    state.done();
  }
});

test("confirmed native receipts retire only behind their own durable channel cursor", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  try {
    queue.storeFor("20").save("100");
    queue.attempt(input());
    queue.receipt(input().identity, "accepted", "native-entry");
    queue.storeFor("21").save("999");
    expect(queue.admission(input().identity, input().fingerprint)?.receipt).toBe("native-entry");
    queue.storeFor("20").save("100");
    expect(queue.admission(input().identity, input().fingerprint)).not.toBeNull();
    queue.storeFor("20").save("101");
    expect(queue.admission(input().identity, input().fingerprint)).toBeNull();
  } finally {
    queue.close();
    state.done();
  }
});

test.each(["accepted", "rejected"] as const)(
  "a saved %s receipt completes its cursor before refreshed history",
  async (outcome) => {
    const state = withState();
    let queue = discordInboundQueue(state.dir);
    try {
      queue.storeFor("20").save("100");
      queue.attempt(input());
      queue.receipt(input().identity, outcome, "native-entry");
      queue.close();
      queue = discordInboundQueue(state.dir);
      await reconcileHead(queue);
      expect(queue.storeFor("20").load()).toBe("101");
      expect(queue.admission(input().identity, input().fingerprint)).toBeNull();
      let resends = 0;
      await headEmitter(queue, "99", "10", () => {
        resends++;
        return "must not replay a committed source";
      })(toInbound(ownerMessage("101", { content: "edited after admission" })));
      expect(resends).toBe(0);
    } finally {
      queue.close();
      state.done();
    }
  },
);

test("an interrupted operator decision finishes only its cursor without another decision or resend", async () => {
  const head = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  expect(await head.exited).toBe(0);
  const state = withState();
  let queue = discordInboundQueue(state.dir);
  try {
    const original = input(head.pid);
    queue.storeFor("20").save("100");
    queue.attempt(original);
    const path = join(state.dir, "discord-inbound", "20.json");
    renameSync(path, `${path}.before`);
    mkdirSync(path, { mode: 0o700 });
    expect(() => queue.abandon(original.identity, "explicit owner decision")).toThrow("private regular file");
    const decision = queue.admission(original.identity, original.fingerprint)!;
    expect(decision.outcome).toBe("abandoned");
    rmdirSync(path);
    renameSync(`${path}.before`, path);
    queue.close();
    queue = discordInboundQueue(state.dir);
    await reconcileHead(queue);
    expect(queue.storeFor("20").load()).toBe("101");
    expect(queue.admission(original.identity, original.fingerprint)).toEqual(decision);
    await reconcileHead(queue);
    expect(queue.abandon(original.identity, decision.reason!)).toEqual(decision);
  } finally {
    queue.close();
    state.done();
  }
});

test("non-retryable admission faults escape the default REST polling helper", async () => {
  let ticks = 0;
  await expect(
    every(
      3 / 60,
      async () => {
        ticks++;
        throw headUnresolved();
      },
      () => false,
    ),
  ).rejects.toThrow("HEAD_ADMISSION_UNRESOLVED");
  expect(ticks).toBe(1);
});

test("public abandonment refuses a live original head and missing or repeated reason flags", async () => {
  await withDiscordCli(async (fixture) => {
    const dir = dirname(fixture.tmp);
    const queue = discordInboundQueue(dir);
    queue.storeFor("20").save("100");
    queue.attempt(input());
    queue.close();
    const command = ["inbound-abandon", "discord", input().identity];
    for (const reason of [[], ["--reason", " "], ["--reason", "one", "--reason", "two"]]) {
      const result = await fixture.invoke([...command, ...reason]);
      expect([result.code, result.out, result.keys]).toEqual([1, "", []]);
      expect(result.err).toContain("one explicit operator abandonment reason");
    }
    const live = await fixture.invoke([...command, "--reason", "explicit owner decision"]);
    expect([live.code, live.out, live.keys]).toEqual([1, "", []]);
    expect(live.err).toContain("Original head is alive");
    const restored = discordInboundQueue(dir);
    try {
      expect(restored.unresolved()?.headPid).toBe(process.pid);
      expect(restored.storeFor("20").load()).toBe("100");
    } finally {
      restored.close();
    }
  });
});

test("public abandonment preserves the original and returns one receipt without any resend", async () => {
  const head = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await head.exited).toBe(0);
  await withDiscordCli(async (fixture) => {
    const dir = dirname(fixture.tmp);
    const queue = discordInboundQueue(dir);
    const original = input(head.pid);
    queue.push("message", ownerMessage("101"));
    queue.push("message", ownerMessage("102"));
    queue.storeFor("20");
    queue.attempt(original);
    const attempted = queue.unresolved()!;
    queue.close();
    const command = [
      "inbound-abandon",
      "discord",
      original.identity,
      "--reason",
      "Owner explicitly forgoes the unconfirmed input",
    ];
    const result = await fixture.invoke(command);
    expect([result.code, result.err, result.keys]).toEqual([0, "", []]);
    expect(result.out).toStartWith("ADMISSION_ABANDONED ");
    const receipt = JSON.parse(result.out.slice("ADMISSION_ABANDONED ".length));
    expect(receipt).toMatchObject({
      identity: original.identity,
      outcome: "abandoned",
      headPid: head.pid,
      headFile: original.headFile,
      attemptedAt: attempted.attemptedAt,
    });
    expect(receipt.receipt).toStartWith("operator-abandon:");
    expect((await fixture.invoke(command)).out).toBe(result.out);
    const conflict = await fixture.invoke([...command.slice(0, -1), "a different reason"]);
    expect(conflict.code).toBe(1);
    const resumed = discordInboundQueue(dir);
    try {
      const saved = resumed.admission(original.identity, original.fingerprint)!;
      expect(saved.source).toBe(JSON.stringify(original.source));
      expect(saved.attemptedAt).toBe(attempted.attemptedAt);
      expect(saved.reason).toBe(command.at(-1)!);
      expect(resumed.unresolved()).toBeNull();
      const world = discordRestWorld([ownerMessage("101", { content: "edited after abandonment" })]);
      const intake = await discordInbound(world.discord, resumed.storeFor, { ownerId: "10", channelIds: ["20"] });
      let resends = 0;
      const emit = headEmitter(resumed, "99", "10", () => {
        resends++;
        return "must not dispatch abandoned source";
      });
      await intake.poll(emit);
      await intake.accept(ownerMessage("101"), emit);
      expect(resends).toBe(0);
      expect(resumed.storeFor("20").load()).toBe("101");
      resumed.remove(resumed.first()!.id);
      expect(JSON.parse(resumed.first()!.payload).id).toBe("102");
      resumed.storeFor("20").save("102");
      expect(resumed.admission(original.identity, original.fingerprint)?.receipt).toBe(receipt.receipt);
    } finally {
      resumed.close();
    }
  });
});
