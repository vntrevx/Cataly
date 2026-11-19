import { expect, test } from "bun:test";
import { ids, withDiscordCli } from "./discord-fakes.ts";
import { create, lane, mutations, options, receiptBytes, register, set } from "./discord-thread-source-fakes.ts";

for (const type of [15, 16])
  test(`source-bound type ${type} preserves the complete fallback starter and fingerprints its full title`, async () => {
    await withDiscordCli(async (f) => {
      const title = "x".repeat(2500);
      const args = create();
      const titleAt = args.indexOf("--title") + 1;
      args[titleAt] = title;
      const scenario = options({
        [`GET /channels/${ids.forum}`]: {
          body: { id: ids.forum, type, available_tags: [{ id: ids.working, name: "working" }] },
        },
      });
      const first = await f.invoke(args, scenario);
      expect([first.code, first.out]).toEqual([0, `THREAD ${ids.thread} mid=${ids.starter}`]);
      const requests = first.requests.filter((request) => !request.key.startsWith("GET "));
      expect(requests.map((request) => request.key)).toEqual([
        `POST /channels/${ids.forum}/threads`,
        `POST /channels/${ids.thread}/messages`,
      ]);
      expect(requests[0]?.body).toMatchObject({
        name: title.slice(0, 100),
        message: { content: title.slice(0, 2000) },
      });
      expect(requests[1]?.body).toMatchObject({ content: title.slice(2000) });
      const bytes = receiptBytes(f);
      const replay = await f.invoke(args, scenario);
      expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([0, first.out, []]);
      args[titleAt] = `${title.slice(0, -1)}y`;
      const conflict = await f.invoke(args, scenario);
      expect([conflict.code, conflict.out, mutations(conflict.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBe(bytes);
    });
  });

test("source-bound set stores the actual bounded title and keeps its receipt replayable", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, `discord:${ids.thread}`);
    const title = "x".repeat(2500);
    const args = set(ids.thread, ["--title", title]);
    const first = await f.invoke(args, options());
    expect([first.code, first.out]).toEqual([0, `THREAD ${ids.thread}`]);
    expect(first.requests.find((request) => request.key.startsWith("PATCH "))?.body).toEqual({
      name: title.slice(0, 100),
    });
    const bytes = receiptBytes(f);
    const replay = await f.invoke(args, options());
    expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([0, first.out, []]);
    expect(receiptBytes(f)).toBe(bytes);
  });
});
