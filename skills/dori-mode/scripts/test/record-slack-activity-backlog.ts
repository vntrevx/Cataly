import { join } from "node:path";
import { readInboundActivity } from "../../../../src/update/source-activity.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";

const realNow = Date.now.bind(Date);
let clock = realNow() - 1_900_000;
Date.now = () => clock;
let ticks = 0;
const dir = process.env["DORI_STATE_DIR"]!;
await new ThreadLedger(join(dir, "slack-threads.json")).record("C_WATCHED", "1", "1");
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://slack.com") throw new Error("unexpected Slack backlog origin");
  let body: unknown;
  if (url.pathname === "/api/auth.test") body = { ok: true, user_id: "U_SELF" };
  else if (url.pathname === "/api/subscriptions.thread.getView") body = { ok: true, threads: [] };
  else if (url.pathname === "/api/client.counts") body = { ok: true, channels: [], ims: [], mpims: [] };
  else if (url.pathname === "/api/conversations.replies") {
    body = {
      ok: true,
      messages:
        ticks === 0
          ? []
          : Array.from({ length: 50 }, (_, index) => ({ ts: String(index + 2), user: "U_SELF", text: "self" })),
      has_more: ticks > 0 && process.env["DORI_TEST_PAGE"] === "has_more",
      response_metadata: {
        next_cursor: ticks > 0 && process.env["DORI_TEST_PAGE"] === "cursor" ? "owner-on-next-page" : "",
      },
    };
  } else throw new Error("unexpected Slack backlog endpoint");
  return new Response(JSON.stringify(body));
}) as typeof fetch;
Object.defineProperty(Bun, "sleep", {
  value: async () => {
    ticks++;
    clock = realNow();
    if (ticks === 2) {
      console.log(`SLACK_ACTIVITY_QA ${JSON.stringify(readInboundActivity(process.env["DORI_TEST_ACTIVITY"]!))}`);
      process.exit(0);
    }
  },
});
