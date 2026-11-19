import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headReceipt } from "../head-receipt.ts";

const roots: string[] = [];
const identity = "99:10:20:101";
const fingerprint = "a".repeat(64);
const receipt = (outcome: "accepted" | "rejected", patch = {}) => ({
  type: outcome === "accepted" ? "custom_message" : "custom",
  customType: outcome === "accepted" ? "dori-monitor" : "omp-dori:admission-rejected",
  id: "native-entry-1",
  [outcome === "accepted" ? "details" : "data"]: { ompDoriAdmission: { identity, fingerprint } },
  ...patch,
});
const transcript = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "dori-native-receipt-"));
  roots.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each(["accepted", "rejected"] as const)(
  "a %s receipt requires the exact original native entry",
  async (outcome) => {
    const file = transcript(`${JSON.stringify(receipt(outcome))}\n`);
    expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome, receipt: "native-entry-1" });
    expect(await headReceipt(file, "99:10:20:102", fingerprint)).toBeUndefined();
  },
);

test("stdout-shaped text and an unterminated native tail are not admission receipts", async () => {
  const body = JSON.stringify(receipt("accepted"));
  const file = transcript(`${JSON.stringify({ type: "message", content: body })}\n${body}`);
  expect(await headReceipt(file, identity, fingerprint)).toBeUndefined();
});

test.each([{ details: { ompDoriAdmission: { identity, fingerprint: "b".repeat(64) } } }, { id: "" }, { id: null }])(
  "conflicting identity metadata never authorizes acknowledgement %#",
  async (patch) => {
    const file = transcript(`${JSON.stringify(receipt("accepted", patch))}\n`);
    await expect(headReceipt(file, identity, fingerprint)).rejects.toThrow("identity conflict");
  },
);

test("large unrelated native entries cannot hide or inflate the bounded receipt read", async () => {
  const file = transcript(
    JSON.stringify({ type: "message", content: "x".repeat(2 * 1024 * 1024) }) +
      "\n" +
      JSON.stringify(receipt("accepted")) +
      "\n",
  );
  expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome: "accepted", receipt: "native-entry-1" });
});

test("reverse proof reads preserve UTF-8 and framing across blocks, oversized entries and a partial tail", async () => {
  const body = JSON.stringify(receipt("accepted", { content: "\ud55c\uae00".repeat(30000) }));
  const unrelated = JSON.stringify({ type: "message", content: "x".repeat(2 * 1024 * 1024) });
  const file = transcript(`${unrelated}\n${body}\n${unrelated}\n${JSON.stringify(receipt("rejected"))}`);
  expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome: "accepted", receipt: "native-entry-1" });
});

test("symlinks and multiply-linked files cannot substitute a native receipt target", async () => {
  const file = transcript(`${JSON.stringify(receipt("accepted"))}\n`);
  const alias = `${file}.alias`;
  symlinkSync(file, alias);
  await expect(headReceipt(alias, identity, fingerprint)).rejects.toThrow();
  linkSync(file, `${file}.hardlink`);
  await expect(headReceipt(file, identity, fingerprint)).rejects.toThrow("owned regular native transcript");
});
