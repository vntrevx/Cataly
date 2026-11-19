import { appendFileSync } from "node:fs";

const raw = process.env["DORI_TEST_TELEGRAM_UPDATES"];
const journal = process.env["DORI_TEST_TELEGRAM_REQUESTS"];
const token = process.env["DORI_TELEGRAM_TOKEN"];
const bot = process.env["DORI_TEST_TELEGRAM_BOT"];
if (raw === undefined || journal === undefined || token === undefined || bot === undefined)
  throw new Error("Telegram epoch fixture is incomplete");
const updates = JSON.parse(raw) as { update_id: number }[];
const identity = JSON.parse(bot);

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const prefix = `/bot${token}/`;
    if (url.origin !== "https://api.telegram.org" || !url.pathname.startsWith(prefix))
      throw new Error("Unexpected Telegram fixture endpoint");
    const method = url.pathname.slice(prefix.length);
    const params = JSON.parse(String(init?.body));
    appendFileSync(journal, `${JSON.stringify({ method, params })}\n`, { mode: 0o600 });
    if (method === "getMe" && process.env["DORI_TEST_TELEGRAM_IDENTITY_FAILURE"] === "1")
      return new Response(JSON.stringify({ ok: false, description: `private ${token}`, error_code: 401 }), {
        status: 401,
      });
    let result: unknown;
    if (method === "getMe") result = identity;
    else if (method === "getUpdates")
      result = updates
        .filter((update) => params.offset === undefined || update.update_id >= params.offset)
        .slice(0, params.limit ?? 100);
    else if (method === "setMessageReaction") result = true;
    else throw new Error("Unexpected Telegram fixture method");
    return new Response(JSON.stringify({ ok: true, result }));
  },
  {
    preconnect() {
      throw new Error("Unexpected Telegram fixture preconnect");
    },
  },
);
