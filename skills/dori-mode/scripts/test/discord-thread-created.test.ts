import { expect, test } from "bun:test";
import { type DcChannel, Discord } from "../src/messenger/discord.ts";
import type { Http } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

for (const mode of ["text", "forum", "message"] as const)
  test(`${mode} creation awaits its receipt before sending further messages`, async () => {
    const events: string[] = [];
    const thread = { id: "40", type: 11, parent_id: "30", owner_id: "99", message: { id: "51" } };
    const http: Http = async ({ url }) => {
      const create = url.endsWith("/threads");
      events.push(create ? "create" : "send");
      return { status: 200, headers: {}, body: JSON.stringify(create ? thread : { id: "52" }) };
    };
    const dc = new Discord(http, fakeClock(0), "synthetic");
    const created = async (received: DcChannel) => {
      await Promise.resolve();
      expect(received).toEqual(thread);
      events.push("receipt");
    };
    const result =
      mode === "message"
        ? await dc.threadOnMessage("30", "40", "task", "starter", created)
        : await dc.createThread({ id: "30", type: mode === "forum" ? 15 : 0 }, "task", {
            text: mode === "forum" ? "x".repeat(2500) : "starter",
            created,
          });
    expect(events).toEqual(["create", "receipt", "send"]);
    expect(result).toEqual({ id: "40", messageId: mode === "forum" ? "51" : "52" });
  });

for (const mode of ["text", "forum", "message"] as const)
  test(`${mode} receipt persistence failure prevents every follow-on send`, async () => {
    let requests = 0;
    const http: Http = async () => {
      requests++;
      return { status: 200, headers: {}, body: JSON.stringify({ id: "40", message: { id: "51" } }) };
    };
    const dc = new Discord(http, fakeClock(0), "synthetic");
    const error = new Error("receipt fsync failed");
    const created = async () => {
      throw error;
    };
    const operation =
      mode === "message"
        ? dc.threadOnMessage("30", "40", "task", "starter", created)
        : dc.createThread({ id: "30", type: mode === "forum" ? 15 : 0 }, "task", {
            text: mode === "forum" ? "x".repeat(2500) : "starter",
            created,
          });
    expect(await operation.catch((value: unknown) => value)).toBe(error);
    expect(requests).toBe(1);
  });

test("a forum thread receipt is observed even when its starter acknowledgement is malformed", async () => {
  let received: unknown;
  let requests = 0;
  const dc = new Discord(
    async () => {
      requests++;
      return { status: 200, headers: {}, body: JSON.stringify({ id: "40", message: {} }) };
    },
    fakeClock(0),
    "synthetic",
  );
  const error = await dc
    .createThread({ id: "30", type: 15 }, "task", {
      text: "x".repeat(2500),
      created: async (thread) => {
        received = thread;
      },
    })
    .catch((value: unknown) => value);
  expect(received).toEqual({ id: "40", message: {} });
  expect(error).toMatchObject({ outcome: "uncertain" });
  expect(requests).toBe(1);
});
