import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { withLocalFile } from "../src/messenger/voice.ts";
import { audioSamples } from "./audio-samples.ts";

test("an actual HTTP stream is cancelled on overflow without waiting for EOF or invoking the hook", async () => {
  const { promise: aborted, resolve: stopped } = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      request.signal.addEventListener("abort", () => stopped(), { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(audioSamples.ogg, "base64").subarray(0, 128));
            // Deliberately no EOF: whole-body buffering would hang instead of enforcing the 64-byte cap.
          },
          cancel() {
            stopped();
          },
        }),
        { headers: { "content-type": "audio/ogg" } },
      );
    },
  });
  let invoked = false;
  const download = withLocalFile(server.url.href, 64, async () => {
    invoked = true;
    return "unexpected hook";
  });
  const { promise: timeout, reject: expired } = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired(new Error("loopback download was not cancelled")), 3000);
  try {
    await expect(Promise.race([download, timeout])).rejects.toThrow("downloaded audio exceeds the limit");
    await Promise.race([aborted, timeout]);
    expect(invoked).toBe(false);
  } finally {
    clearTimeout(timer);
    server.stop(true);
    await Promise.allSettled([download]);
  }
});

test("an actual HTTP download reaches the hook only with the exact bounded audio bytes and private file mode", async () => {
  const bytes = Buffer.from(audioSamples.wav, "base64");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(bytes, { headers: { "content-type": "audio/wav" } }),
  });
  let file: string | undefined;
  try {
    const result = await withLocalFile(server.url.href, bytes.length, async (path) => {
      file = path;
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      return "bounded transcript";
    });
    expect(result).toBe("bounded transcript");
    expect(file).toBeDefined();
    expect(statSync(file!, { throwIfNoEntry: false })).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("attachment metadata bounds decoded bytes, not compression overhead in Content-Length", async () => {
  const bytes = Buffer.from("small file");
  const encoded = Bun.gzipSync(bytes);
  expect(encoded.length).toBeGreaterThan(bytes.length);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(encoded, {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(encoded.length),
        },
      }),
  });
  try {
    const result = await withLocalFile(
      async (signal) => ({
        name: "small.txt",
        response: await fetch(server.url, { signal }),
        expectedSize: bytes.length,
      }),
      1024,
      async (file) => {
        expect(readFileSync(file)).toEqual(bytes);
        return "complete";
      },
      false,
    );
    expect(result).toBe("complete");
  } finally {
    server.stop(true);
  }
});
