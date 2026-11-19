import { expect, test } from "bun:test";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordSourceFingerprint } from "../src/messenger/discord-source-fingerprint.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

const attachment = {
  filename: "note.txt",
  size: 7,
  url: "https://cdn.discordapp.com/attachments/20/900/note.txt?ex=1&is=2&hm=3&quality=lossless",
};
const original = ownerMessage("101", {
  content: "original owner input",
  attachments: [attachment],
  message_reference: { message_id: "50" },
  referenced_message: { id: "50", author: { id: "11" }, content: "borrowed reply context" },
});
const refreshed = {
  ...original,
  referenced_message: null,
  author: { ...original.author, username: "renamed" },
  attachments: [{ ...attachment, url: attachment.url.replace("ex=1&is=2&hm=3", "ex=9&is=8&hm=7") }],
};

test("signed URL refresh and missing reply context preserve the original source fingerprint", () => {
  expect(discordSourceFingerprint(toInbound(original))).toBe(discordSourceFingerprint(toInbound(refreshed)));
  const editedReply = { ...original, referenced_message: { ...original.referenced_message!, content: "edited reply" } };
  expect(discordSourceFingerprint(toInbound(original))).toBe(discordSourceFingerprint(toInbound(editedReply)));
  expect(toInbound(original).attachments[0]?.url).toBe(attachment.url);
});

test("actual owner content, reference and attachment identity changes remain conflicts", () => {
  const fingerprint = discordSourceFingerprint(toInbound(original));
  for (const changed of [
    { ...original, content: "different owner input" },
    { ...original, message_reference: { message_id: "51" } },
    { ...original, attachments: [{ ...attachment, url: attachment.url.replace("/900/", "/901/") }] },
    { ...original, attachments: [{ ...attachment, url: attachment.url.replace("lossless", "lossy") }] },
  ])
    expect(discordSourceFingerprint(toInbound(changed))).not.toBe(fingerprint);
  const external = { ...original, attachments: [{ ...attachment, url: "https://example.test/a?ex=1" }] };
  const other = { ...external, attachments: [{ ...attachment, url: "https://example.test/a?ex=2" }] };
  expect(discordSourceFingerprint(toInbound(external))).not.toBe(discordSourceFingerprint(toInbound(other)));
});

test("raw redelivery keeps its first captured payload across signature and reply changes", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  try {
    queue.push("message", original);
    queue.push("message", refreshed);
    expect(JSON.parse(queue.first()!.payload)).toEqual(original);
    expect(() => queue.push("message", { ...refreshed, content: "changed owner instruction" })).toThrow(
      "identity conflict",
    );
    queue.remove(queue.first()!.id);
    expect(queue.first()).toBeNull();
  } finally {
    queue.close();
    state.done();
  }
});
