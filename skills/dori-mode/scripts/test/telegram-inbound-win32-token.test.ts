import { expect, test } from "bun:test";
import { sidOffset } from "../src/messenger/telegram-inbound-win32-ffi.ts";
import { sid } from "../src/messenger/telegram-inbound-win32-native.ts";

const baseAddress = 0x00007fff12340000n;

const tokenResult = (sidAddress: bigint) => {
  const result = Buffer.alloc(128);
  result.writeBigUInt64LE(sidAddress);
  return result;
};

test("TOKEN_USER resolves a 64-bit PSID relative to the supplied buffer, not by assuming adjacent SID bytes", () => {
  const result = tokenResult(baseAddress + 24n);
  const expected = Buffer.from("010100000000000512000000", "hex");
  expected.copy(result, 24);
  const written = 36;

  expect(sid(result.subarray(0, written), sidOffset(result, baseAddress, written))).toEqual(expected);
});

test.each([baseAddress - 8n, baseAddress + 8n, baseAddress + 32n, baseAddress + 0x100000018n])(
  "TOKEN_USER rejects a PSID outside the reported SID region (%s)",
  (pointer) => {
    expect(() => sidOffset(tokenResult(pointer), baseAddress, 36)).toThrow("TOKEN_USER SID pointer is out of range");
  },
);

test.each([15, 129])("TOKEN_USER rejects an invalid reported byte count (%i)", (written) => {
  expect(() => sidOffset(tokenResult(baseAddress + 16n), baseAddress, written)).toThrow(
    "TOKEN_USER byte count is invalid",
  );
});

test("TOKEN_USER rejects a SID body that continues past the reported bytes", () => {
  const result = tokenResult(baseAddress + 16n);
  result.set([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0], 16);
  const written = 24;
  const offset = sidOffset(result, baseAddress, written);

  expect(() => sid(result.subarray(0, written), offset)).toThrow("SID is invalid");
});
