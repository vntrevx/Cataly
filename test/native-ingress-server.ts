import { readFileSync } from "node:fs";
import type { IngressEvents } from "./native-ingress-events.ts";

export type IngressTool = { name: string; arguments: Record<string, unknown> };
export const ownerMessage = (id: string) => ({
  id,
  type: 0,
  channel_id: "20",
  author: { id: "10", bot: false },
  content: `owner input ${id}`,
  attachments: [],
});

const readEntries = (file: string): Array<Record<string, unknown>> => {
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

/** Actual HTTP for both native OpenAI streaming and the real Discord CLI. No fetch replacement supplies answers. */
export function ingressServer(events: IngressEvents) {
  const actions = new Map<string, IngressTool>();
  const messages = [ownerMessage("101"), ownerMessage("102")];
  const posts: unknown[] = [];
  const requests: unknown[] = [];
  let sessionFile: string | undefined;
  let ambiguous = false;
  let serial = 0;
  const entries = (): Array<Record<string, unknown>> => (sessionFile ? readEntries(sessionFile) : []);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/v1/chat/completions") {
        const body = (await request.json()) as { model: string; messages: unknown[] };
        if (body.model !== "ingress-fixture") throw new Error(`Unexpected fixture model: ${body.model}`);
        requests.push(body);
        const history = JSON.stringify(body.messages);
        const action = [...actions].find(([marker]) => history.includes(marker));
        if (action) actions.delete(action[0]);
        const tool = action?.[1];
        events.record({ kind: "provider", model: body.model, marker: action?.[0], tool: tool?.name });
        const id = `fixture-${++serial}`;
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                },
              ],
            }
          : { role: "assistant", content: "Fixture response; no unrequested action." };
        const chunk = (value: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: value, finish_reason: finish }],
          })}\n\n`;
        return new Response(`${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path === "/control") {
        const body = (await request.json()) as {
          kind: string;
          reply?: { receipt?: string; headFile?: string };
          [key: string]: unknown;
        };
        const published =
          body.reply?.receipt && body.reply.headFile
            ? readEntries(body.reply.headFile).some(
                (entry) =>
                  entry["id"] === body.reply!.receipt &&
                  entry["type"] === "custom_message" &&
                  entry["customType"] === "dori-monitor",
              )
            : undefined;
        events.record({ ...body, ...(published === undefined ? {} : { published }) });
        return Response.json({ ok: true });
      }
      events.record({ kind: "http", method: request.method, path, query: url.search });
      if (path === "/api/v10/users/@me") return Response.json({ id: "99", bot: true });
      if (path === "/api/v10/applications/@me") return Response.json({ flags: 1 << 18 });
      if (path === "/api/v10/channels/20") return Response.json({ id: "20", type: 1, name: "fixture" });
      if (path === "/api/v10/channels/20/messages" && request.method === "GET") {
        const before = url.searchParams.get("before");
        const rows = messages.filter((row) => !before || BigInt(row.id) < BigInt(before));
        return Response.json(
          rows
            .toSorted((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
            .slice(0, Number(url.searchParams.get("limit") ?? 100)),
        );
      }
      if (path === "/api/v10/channels/20/messages" && request.method === "POST") {
        posts.push(await request.json());
        events.record({ kind: "posted", count: posts.length, ambiguous });
        // The remote effect happened, but its successful HTTP response is unreadable: success cannot be claimed.
        return ambiguous
          ? new Response("{", { headers: { "content-type": "application/json" } })
          : Response.json({ id: String(200 + posts.length) });
      }
      if (/\/messages\/(101|102)\/reactions\//.test(path)) {
        const id = path.split("/")[6];
        const persisted = entries().filter(
          (entry) => entry["type"] === "custom_message" && entry["customType"] === "dori-monitor",
        );
        events.record({ kind: "reaction", id, published: JSON.stringify(persisted).includes(`99:10:20:${id}`) });
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v10/channels/20/typing") return new Response(null, { status: 204 });
      events.record({ kind: "unexpected-http", method: request.method, path });
      return Response.json({ error: "Unexpected fixture route" }, { status: 400 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    messages,
    posts,
    requests,
    entries,
    action(marker: string, tool: IngressTool) {
      actions.set(marker, tool);
    },
    bind(file: string) {
      sessionFile = file;
    },
    ambiguousSend() {
      ambiguous = true;
    },
    close() {
      server.stop(true);
    },
  };
}
