import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertSourceBundle, bundleGit, readSourceBundle, type SourceBundle } from "../src/release/source-bundle.ts";
import { generateSourceBundle } from "../src/release/source-bundle-update.ts";

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      checkout: { type: "string" },
      source: { type: "string" },
      commit: { type: "string" },
      version: { type: "string" },
    },
  });
  if (!values.checkout || !values.commit || !values.version || !/^[a-f0-9]{40}$/.test(values.commit))
    throw new Error(
      "Usage: bun scripts/update-native-omp.ts --checkout CHECKOUT --commit EXACT_SHA --version VERSION [--source DORI]",
    );
  const source = realpathSync(resolve(values.source ?? join(import.meta.dir, "..")));
  const checkout = realpathSync(resolve(values.checkout));
  const previous = readSourceBundle(source, true).lock;
  const launcher = previous.launcher;
  if (typeof launcher !== "string") throw new Error("Native source lock requires a launcher");
  const version = JSON.parse(readFileSync(join(checkout, "packages/coding-agent/package.json"), "utf8")).version;
  if (version !== values.version) throw new Error("Native package version differs from the requested release");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-metadata-")));
  try {
    const commit = await bundleGit(["rev-parse", "--verify", "HEAD^{commit}"], checkout, home);
    if (commit !== values.commit) throw new Error("Native checkout differs from the exact requested commit");
    const patchPath = join(home, "native-omp.patch");
    const captured = await generateSourceBundle(checkout, patchPath, previous.repository, home);
    const lock: SourceBundle = { ...captured, nativeVersion: version, launcher };
    writeFileSync(join(home, "native-omp.lock"), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    assertSourceBundle(checkout, readSourceBundle(home, true), home);
    writeFileSync(join(source, "native-omp.patch"), readFileSync(patchPath));
    writeFileSync(join(source, "native-omp.lock"), `${JSON.stringify(lock, null, 2)}\n`);
    console.log(JSON.stringify({ commit, version, resultTree: lock.resultTree, files: lock.files.length }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
