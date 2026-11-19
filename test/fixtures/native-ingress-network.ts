/** Loaded before the real CLI and its real messenger child. No external account or catalog request may leave. */
const allowed = process.env["DORI_TEST_INGRESS_ORIGIN"];
if (!allowed || new URL(allowed).hostname !== "127.0.0.1") throw new Error("Native ingress fixture needs its loopback origin");
const original = globalThis.fetch;
const check = (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== allowed) throw new Error(`Native ingress fixture blocked external fetch: ${url.origin}`);
};
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    check(input);
    return original(input, init);
  },
  { preconnect: (input: string | URL) => { check(input); } },
);
