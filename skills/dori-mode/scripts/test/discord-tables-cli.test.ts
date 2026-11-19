import { expect, test } from "bun:test";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const table = "| Name | Count |\n| --- | ---: |\n| a | 1 |\n| longer | 22 |";
const rendered =
  "\x60\x60\x60\n| Name   | Count |\n| ------ | ----- |\n| a      |     1 |\n| longer |    22 |\n\x60\x60\x60";
const sparse = ["| a | b |", "| --- | --- |", `| ${"x".repeat(40)} | 1 |`, ...Array(99).fill("| y | 2 |")].join("\n");
const send = ["send", "discord", "--thread", ids.thread];
const post = `POST /channels/${ids.thread}/messages`;

test("Discord table rendering is opt-in and retains first-message reply and no-mention data", async () => {
  await withDiscordCli(async (f) => {
    const plain = await f.invoke([...send, "--text", table]);
    expect([plain.code, plain.requests[0]?.body?.["content"]]).toEqual([0, table]);
    const result = await f.invoke([...send, "--render-tables", "--reply", ids.message, "--text", table]);
    expect([result.code, result.err, result.out, result.keys]).toEqual([0, "", `SENT ${ids.message}`, [post]]);
    expect(result.requests[0]?.body).toEqual({
      content: rendered,
      allowed_mentions: { parse: [] },
      message_reference: { message_id: ids.message, fail_if_not_exists: false },
    });
  });
});

test("rendered Discord tables use the existing lossless fence splitting and reply only once", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke([...send, "--render-tables", "--reply", ids.message, "--text-file", "-"], {
      stdin: sparse,
      routes: { [post]: { sequence: ["71", "72", "73"].map((id) => ({ body: { id } })) } },
    });
    expect([result.code, result.err, result.out, result.keys]).toEqual([0, "", "SENT 71 72 73", Array(3).fill(post)]);
    const parts = result.requests.map((request) => String(request.body?.["content"]));
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2000);
      expect(part).toStartWith("\x60\x60\x60\n");
      expect(part).toEndWith("\x60\x60\x60");
    }
    const lines = parts
      .map((part) => part.slice(4, -3))
      .join("")
      .trimEnd()
      .split("\n");
    expect(lines).toEqual([
      `| ${"a".padEnd(40)} | b   |`,
      `| ${"-".repeat(40)} | --- |`,
      `| ${"x".repeat(40)} | 1   |`,
      ...Array(99).fill(`| ${"y".padEnd(40)} | 2   |`),
    ]);
    expect(result.requests.map((request) => request.body?.["message_reference"])).toEqual([
      { message_id: ids.message, fail_if_not_exists: false },
      undefined,
      undefined,
    ]);
    for (const request of result.requests) expect(request.body?.["allowed_mentions"]).toEqual({ parse: [] });
  });
});

test("a failed rendered table part stops delivery and retains its confirmed message receipt", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke([...send, "--render-tables", "--text", sparse], {
      routes: { [post]: { sequence: [{ body: { id: "71" } }, { status: 403, body: { message: "Denied" } }] } },
    });
    expect([result.code, result.out, result.keys]).toEqual([1, "", [post, post]]);
    expect(result.err).toEndWith("(part 2 of 3; already posted: 71)");
  });
});

test("an edit renders before its single-message length check and never falls back to a post", async () => {
  await withDiscordCli(async (f) => {
    const small = await f.invoke([...send, "--edit", ids.message, "--render-tables", "--text", table]);
    expect([small.code, small.keys, small.requests[0]?.body]).toEqual([
      0,
      [`PATCH /channels/${ids.thread}/messages/${ids.message}`],
      { content: rendered },
    ]);
    expect(sparse.length).toBeLessThan(2000);
    const large = await f.invoke([
      "send",
      "discord",
      "--to",
      ids.text,
      "--edit",
      ids.message,
      "--render-tables",
      "--text",
      sparse,
    ]);
    expect([large.code, large.keys, large.err]).toEqual([
      1,
      [],
      "--edit text exceeds 2000 UTF-16 code units; shorten the text or send without --edit",
    ]);
  });
});

test("unsupported table width leaves the original input on the normal delivery path", async () => {
  await withDiscordCli(async (f) => {
    const wide = `| h |
| --- |
| ${"x".repeat(80)} |`;
    const result = await f.invoke([...send, "--render-tables", "--text", wide]);
    expect([result.code, result.requests[0]?.body?.["content"]]).toEqual([0, wide]);
  });
});

test("table rendering retains the text safety check and rejects unsupported send platforms", async () => {
  await withDiscordCli(async (f) => {
    const unsafe = await f.invoke([...send, "--render-tables", "--text", "| h |\n| --- |\n| $(id) |"]);
    expect([unsafe.code, unsafe.keys]).toEqual([1, []]);
    expect(unsafe.err).toContain("$(");
    for (const platform of ["slack", "telegram"]) {
      const result = await f.invoke(["send", platform, "--to", "1", "--render-tables", "--text", table]);
      expect([result.code, result.keys, result.err]).toEqual([1, [], "--render-tables is supported for discord only"]);
    }
  });
});
