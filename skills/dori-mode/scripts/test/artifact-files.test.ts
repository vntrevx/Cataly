import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactWithin, inspectArtifact } from "../src/artifact-files.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let root: string;
const roots = () => [{ path: root, baseUrl: "https://files.example/reports/" }];
beforeEach(() => {
  state = withState();
  root = join(state.dir, "files");
  mkdirSync(root);
});
afterEach(() => state.done());
const file = (name: string, text = "evidence") => {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};

test("hashes actual bytes, including an empty file, and never guesses a private URL", async () => {
  for (const text of ["", "actual evidence\n"]) {
    const path = file("report.txt", text);
    expect(await inspectArtifact(roots(), path, "private")).toMatchObject({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
      url: null,
    });
  }
});
test("public URLs encode each path component including parentheses and non-ASCII bytes", async () => {
  const path = file("part one/\uacb0\uacfc (v1).HTML");
  expect((await inspectArtifact(roots(), path, "public")).url).toBe(
    "https://files.example/reports/part%20one/%EA%B2%B0%EA%B3%BC%20%28v1%29.HTML",
  );
});
test("no root, sibling prefixes, traversal and missing public mapping are refused", async () => {
  const path = file("report.txt");
  expect(artifactWithin(root, root)).toBe(true);
  expect(artifactWithin(root, `${root}-sibling/report.txt`)).toBe(false);
  await expect(inspectArtifact([], path, "private")).rejects.toThrow("configured containing root");
  await expect(inspectArtifact([{ path: root }], path, "public")).rejects.toThrow("baseUrl");
  await expect(inspectArtifact(roots(), join(root, "..", "outside.txt"), "private")).rejects.toThrow(
    "configured containing root",
  );
  await expect(inspectArtifact(roots(), `${root}-sibling/report.txt`, "public")).rejects.toThrow(
    "configured containing root",
  );
});
test.each([
  ".hidden/report.txt",
  "node_modules/report.txt",
  "__pycache__/report.txt",
  "site-packages/report.txt",
  "my-SeCrEt.txt",
  "credential/report.txt",
  "token.json",
  "private-notes.txt",
  "line\nbreak.txt",
  "bidi\u202e.txt",
  "program.sh",
  "script.ts",
])("refuses protected path or type: %s", async (name) => {
  const path = file(name);
  await expect(inspectArtifact(roots(), path, "private")).rejects.toThrow();
  await expect(inspectArtifact(roots(), path, "public")).rejects.toThrow();
});
test("the most specific root cannot fall through to a wider public mapping", async () => {
  const path = file("restricted/report.txt");
  const configured = [...roots(), { path: join(root, "restricted") }];
  await expect(inspectArtifact(configured, path, "public")).rejects.toThrow("baseUrl");
  expect((await inspectArtifact(configured, path, "private")).url).toBeNull();
});
test("allows internal aliases but rejects escape and hidden canonical targets", async () => {
  const path = file("report.txt");
  const alias = join(root, "alias.txt");
  symlinkSync(path, alias);
  expect((await inspectArtifact(roots(), alias, "public")).url).toEndWith("/alias.txt");
  const outside = join(state.dir, "outside.txt");
  writeFileSync(outside, "not published");
  unlinkSync(alias);
  symlinkSync(outside, alias);
  await expect(inspectArtifact(roots(), alias, "public")).rejects.toThrow("outside");
  unlinkSync(alias);
  symlinkSync(file(".hidden.txt"), alias);
  await expect(inspectArtifact(roots(), alias, "private")).rejects.toThrow("hidden");
});
test("rejects directories and FIFOs without opening a blocking stream", async () => {
  const directory = join(root, "dir.txt");
  mkdirSync(directory);
  await expect(inspectArtifact(roots(), directory, "private")).rejects.toThrow("regular file");
  const fifo = join(root, "pipe.txt");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  await expect(inspectArtifact(roots(), fifo, "private")).rejects.toThrow("regular file");
});
test("rejects real byte changes and atomic replacement during the stream", async () => {
  const path = file("report.txt", "original");
  const changing = inspectArtifact(roots(), path, "public");
  writeFileSync(path, "changed");
  await expect(changing).rejects.toThrow("changed");
  const replacing = inspectArtifact(roots(), path, "public");
  renameSync(file("replacement.txt", "replacement"), path);
  await expect(replacing).rejects.toThrow("changed");
});
test("rejects symlink retargeting and root replacement during the stream", async () => {
  const first = file("first.txt"),
    second = file("second.txt", "second");
  const alias = join(root, "alias.txt");
  symlinkSync(first, alias);
  const reading = inspectArtifact(roots(), alias, "public");
  unlinkSync(alias);
  symlinkSync(second, alias);
  await expect(reading).rejects.toThrow("changed");
  const next = inspectArtifact(roots(), first, "public");
  renameSync(root, `${root}-moved`);
  mkdirSync(root);
  writeFileSync(join(root, "first.txt"), "replacement");
  await expect(next).rejects.toThrow("changed");
});
