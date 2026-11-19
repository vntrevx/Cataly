import { expect, test } from "bun:test";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

test("queued source redelivery is deduplicated without moving the FIFO fence", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  try {
    const source = ownerMessage("101");
    queue.push("message", source);
    queue.push("message", { ...source });
    queue.push("message", ownerMessage("102"));
    expect(JSON.parse(queue.first()!.payload).id).toBe("101");
    queue.remove(queue.first()!.id);
    expect(JSON.parse(queue.first()!.payload).id).toBe("102");
    queue.remove(queue.first()!.id);
    expect(queue.first()).toBeNull();
  } finally {
    queue.close();
    state.done();
  }
});

test("conflicting payloads cannot reuse a pending source identity", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  try {
    queue.push("message", ownerMessage("101"));
    expect(() => queue.push("message", ownerMessage("101", { content: "different" }))).toThrow("identity conflict");
    expect(JSON.parse(queue.first()!.payload).content).not.toBe("different");
  } finally {
    queue.close();
    state.done();
  }
});

test("an unresolved head attempt survives restart and never grants replay authority", () => {
  const state = withState();
  let queue = discordInboundQueue(state.dir);
  try {
    queue.push("message", ownerMessage("101"));
    queue.attempt({
      identity: "99:10:20:101",
      fingerprint: "a".repeat(64),
      headFile: "/head/session.jsonl",
      headPid: process.pid,
      source: toInbound(ownerMessage("101")),
    });
    queue.close();
    queue = discordInboundQueue(state.dir);
    expect(queue.admission("99:10:20:101", "a".repeat(64))).toMatchObject({
      headPid: process.pid,
      source: JSON.stringify(toInbound(ownerMessage("101"))),
      attemptedAt: expect.any(String),
      headFile: "/head/session.jsonl",
      outcome: "unresolved",
      receipt: null,
    });
    expect(() =>
      queue.attempt({
        identity: "99:10:20:101",
        fingerprint: "a".repeat(64),
        headFile: "/head/other.jsonl",
        headPid: process.pid,
        source: toInbound(ownerMessage("101")),
      }),
    ).toThrow("already attempted");
    expect(JSON.parse(queue.first()!.payload).id).toBe("101");
    expect(() => queue.admission("99:10:20:101", "b".repeat(64))).toThrow("identity conflict");
  } finally {
    queue.close();
    state.done();
  }
});

test.each(["accepted", "rejected"] as const)(
  "a durable %s receipt remains bound to its original identity",
  (outcome) => {
    const state = withState();
    let queue = discordInboundQueue(state.dir);
    try {
      queue.attempt({
        identity: "99:10:20:101",
        fingerprint: "a".repeat(64),
        headFile: "/head/session.jsonl",
        headPid: process.pid,
        source: toInbound(ownerMessage("101")),
      });
      queue.receipt("99:10:20:101", outcome, "entry-1");
      queue.close();
      queue = discordInboundQueue(state.dir);
      expect(queue.admission("99:10:20:101", "a".repeat(64))).toMatchObject({
        headPid: process.pid,
        source: JSON.stringify(toInbound(ownerMessage("101"))),
        attemptedAt: expect.any(String),
        headFile: "/head/session.jsonl",
        outcome,
        receipt: "entry-1",
      });
      queue.receipt("99:10:20:101", outcome, "entry-1");
      expect(() => queue.receipt("99:10:20:101", outcome, "entry-2")).toThrow("receipt conflict");
    } finally {
      queue.close();
      state.done();
    }
  },
);
