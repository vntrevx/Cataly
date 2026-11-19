import { chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const platform = process.env["DORI_TEST_PLATFORM"];
if (platform === "discord") await import("./record-discord-inbound.ts");
else {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.origin !== "https://slack.com") throw new Error("unexpected intake test origin");
    const replies: Record<string, unknown> = {
      "/api/auth.test": { ok: true, user_id: "U_SELF" },
      "/api/subscriptions.thread.getView": { ok: true, threads: [] },
      "/api/client.counts": { ok: true, channels: [], ims: [], mpims: [] },
    };
    if (!Object.hasOwn(replies, url.pathname)) throw new Error("unexpected intake endpoint");
    return new Response(JSON.stringify(replies[url.pathname]));
  }) as typeof fetch;
}
const log = console.log;
console.log = (...args: unknown[]) => {
  if (String(args[0]).startsWith("INBOUND_READY ")) {
    const path = process.env["DORI_TEST_ACTIVITY"]!;
    if (platform === "discord") chmodSync(path, 0o666);
    else unlinkSync(join(path + ".lock", "owner.json"));
  }
  log(...args);
};
