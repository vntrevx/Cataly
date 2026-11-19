import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDiscordAskMailbox,
  routeDiscordAskReply,
} from "../../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";

const owner = "109867692300000001";
const channel = "109867692300000002";
const question = "109867692300000003";
const message = "109867692300000004";

test("only an owner reply to the exact question and channel leaves a durable answer", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  const input = { channel, reference: question, message, text: "the answer" };
  try {
    expect(routeDiscordAskReply(root, input, owner)).toBe(false);
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    try {
      expect(routeDiscordAskReply(root, { ...input, reference: null }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, { ...input, reference: channel }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, { ...input, channel: owner }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, input, channel)).toBe(false);
      expect(mailbox.replies(new Set())).toEqual([]);
      expect(routeDiscordAskReply(root, input, owner)).toBe(true);
      expect(routeDiscordAskReply(root, { ...input, text: "replayed under the same ID" }, owner)).toBe(true);
      expect(mailbox.replies(new Set())).toEqual([{ id: message, text: "the answer" }]);
      expect(mailbox.replies(new Set([message]))).toEqual([]);
    } finally {
      mailbox.close();
    }
    expect(routeDiscordAskReply(root, { ...input, message: "109867692300000005" }, owner)).toBe(true);
    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
