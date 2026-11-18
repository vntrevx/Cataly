import { expect, test } from "bun:test";

import { type Http, type HttpResponse, MessengerError } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const reply = (result: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ ok: true, result }),
});

test.each([4095, 4096, 4097, 8192, 8193])(
  "plain Telegram sends respect the 4096 boundary at %i units",
  async (size) => {
    const posted: string[] = [];
    const http: Http = async (req) => {
      const body = JSON.parse(String(req.body));
      if (
        !req.url.endsWith("/sendMessage") ||
        body.text.length > 4096 ||
        Buffer.from(body.text).toString("utf8") !== body.text
      )
        return { status: 400, headers: {}, body: '{"ok":false,"description":"invalid text"}' };
      posted.push(body.text);
      return reply({ message_id: posted.length });
    };
    const text = "x".repeat(size);
    const id = await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text);
    expect(posted).toHaveLength(Math.ceil(size / 4096));
    expect(posted.join("")).toBe(text);
    expect(id).toBe(posted.length);
  },
);

test.each([
  ["ASCII boundary", "x".repeat(4096), false],
  ["non-BMP boundary", "\u{1f600}".repeat(2048), false],
  ["short HTML", "<b>short &amp; intact</b>", true],
] as const)("a %s Telegram edit keeps one existing message", async (_, text, rich) => {
  const messages = new Map([[42, "original"]]);
  let calls = 0;
  const http: Http = async (req) => {
    calls++;
    const body = JSON.parse(String(req.body));
    if (!req.url.endsWith("/editMessageText") || !messages.has(body.message_id))
      return { status: 400, headers: {}, body: '{"ok":false,"description":"unknown message"}' };
    messages.set(body.message_id, body.text);
    return reply(true);
  };
  await new Telegram(http, fakeClock(0), "b").edit({ chatId: 1, threadId: 9 }, 42, text, rich);
  expect([...messages]).toEqual([[42, text]]);
  expect(calls).toBe(1);
});

test("an HTML send keeps tags and entities in one request even when markup exceeds the plain-text bound", async () => {
  const text = `<b>${"x".repeat(4090)}&amp;</b>`;
  const posted: string[] = [];
  const http: Http = async (req) => {
    const body = JSON.parse(String(req.body));
    if (
      !req.url.endsWith("/sendMessage") ||
      body.parse_mode !== "HTML" ||
      !body.text.startsWith("<b>") ||
      !body.text.endsWith("&amp;</b>")
    )
      return { status: 400, headers: {}, body: '{"ok":false,"description":"incomplete HTML"}' };
    posted.push(body.text);
    return reply({ message_id: posted.length });
  };
  expect(await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text, true)).toBe(1);
  expect(posted).toEqual([text]);
});

test.each([
  ["non-BMP plain text", `${"\u{1f600}".repeat(2048)}x`, false],
  // Telegram counts the text after entities parsing, so markup alone does not make an edit oversized.
  ["HTML markup", `<b>${"x".repeat(4100)}&amp;</b>`, true],
] as const)("an oversized %s edit fails actionably before any mutation", async (_, text, rich) => {
  const messages = ["original"];
  let calls = 0;
  const http: Http = async () => {
    calls++;
    messages[0] = "mutated";
    return reply(true);
  };
  const error = await new Telegram(http, fakeClock(0), "b")
    .edit({ chatId: 1 }, 42, text, rich)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MessengerError);
  expect((error as Error).message).toMatch(/shorten.*--edit/);
  expect({ messages, calls }).toEqual({ messages: ["original"], calls: 0 });
});

test.each([
  "not JSON",
  "null",
  "[]",
  '{"ok":true}',
  '{"ok":true,"result":null}',
  '{"ok":true,"result":{"message_id":"7"}}',
  '{"ok":true,"result":{"message_id":0}}',
])("a malformed Telegram response stops a long send before another part: %s", async (body) => {
  let calls = 0;
  const http: Http = async () => {
    calls++;
    return { status: 200, headers: {}, body };
  };
  await expect(new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, "x".repeat(8193))).rejects.toBeInstanceOf(
    MessengerError,
  );
  expect(calls).toBe(1);
});

test("a long HTML report splits into bodies that are each valid markup and keep their text", async () => {
  const posted: string[] = [];
  // Telegram refuses unbalanced markup, so the fake rejects a body whose tags do not pair, as the API does.
  const balanced = (body: string): boolean => {
    const stack: string[] = [];
    for (const m of body.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
      const [, closing, name = ""] = m;
      if (closing === "") stack.push(name);
      else if (stack.pop() !== name) return false;
    }
    return stack.length === 0;
  };
  const http: Http = async (req) => {
    const body = JSON.parse(String(req.body));
    const text = String(body.text);
    const visible = text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");
    if (!req.url.endsWith("/sendMessage") || visible.length > 4096 || !balanced(text))
      return { status: 400, headers: {}, body: '{"ok":false,"description":"invalid markup"}' };
    posted.push(text);
    return reply({ message_id: posted.length });
  };
  const rows = Array.from({ length: 900 }, (_, i) => `<pre>row ${i} &amp; more</pre>`).join("\n");
  const id = await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, rows, true);
  expect(posted.length).toBeGreaterThan(1);
  expect(id).toBe(posted.length);
  // Every character survives: the parts join back to the source once the added tags are removed.
  expect(posted.join("").replace(/<\/?pre>/g, "")).toBe(rows.replace(/<\/?pre>/g, ""));
});

test("a reply rides only the first body of a split send", async () => {
  const seen: unknown[] = [];
  const http: Http = async (req) => {
    seen.push(JSON.parse(String(req.body)).reply_parameters);
    return reply({ message_id: seen.length });
  };
  await new Telegram(http, fakeClock(0), "b").send({ chatId: 1, replyTo: 42 }, "x".repeat(9000));
  expect(seen).toHaveLength(3);
  expect(seen[0]).toEqual({ message_id: 42, allow_sending_without_reply: true });
  expect(seen.slice(1)).toEqual([undefined, undefined]);
});

test("an HTML body is split on the characters Telegram counts, not on its markup", async () => {
  const posted: string[] = [];
  const http: Http = async (req) => {
    posted.push(String(JSON.parse(String(req.body)).text));
    return reply({ message_id: posted.length });
  };
  // 5000 visible characters behind a lot of markup: over the bound, so it must split, and never mid-tag.
  const text = `<b>${Array.from({ length: 500 }, () => "x".repeat(10)).join("</b><b>")}</b>`;
  await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text, true);
  expect(posted.length).toBe(2);
  for (const part of posted) expect(part.startsWith("<b>") && part.endsWith("</b>")).toBe(true);
});
