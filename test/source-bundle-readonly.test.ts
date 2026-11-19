import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

test("rejecting staged source drift leaves both the shared index and object database unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-readonly-source-"));
  try {
    const f = overlayFixture(join(root, "bundle"), join(root, "checkout"));
    f.put("presets.ts", "export const changed = true;\n");
    fixtureGit(f.checkout, "add", "presets.ts");
    const objects = join(f.checkout, ".git/objects");
    const before = sourceManifest(objects);
    const index = readFileSync(join(f.checkout, ".git/index"));
    expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), root)).toThrow("source checkout differs");
    expect(sourceManifest(objects)).toEqual(before);
    expect(readFileSync(join(f.checkout, ".git/index"))).toEqual(index);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
