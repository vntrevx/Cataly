import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { manifestPath, releasePath, verifyRelease } from "../src/release/state.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, fixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

// Exact automatic.ts, state.ts, manifest.ts and consumer/omp bytes from e6b60c9f5efd45925645672e1841a8a9e20e5592.
// Text fixtures keep the exact bytes reviewable and independent of Git history or a sibling baseline checkout.
// Only these admission modules are historical; their other dependencies are the real current source, not stubs.
const frozenAdmission = [
  ["src/release/automatic.ts", "999701297a006279797b0e1006b6219b7c423a43d878effbd315a6a2b101341d"],
  ["src/release/state.ts", "65ea13b440235dd3ec22650dd59cd542613e652cef882f5866b692a8281b7f7a"],
  ["src/release/manifest.ts", "37b62455d91ed5cc27c887e6cbcac00d7a2d89dcb8a74c0c33bace3f4f432d30"],
  ["scripts/consumer/omp", "7efa973ec21fc9e79841c2685f491155f3d9b0b40999bf4d2ed84c39ca0fb916"],
] as const;

function repack(bundle: VerifiedBundle, source: string, omp = bundle.manifest.requirements.omp): VerifiedBundle {
  const publicSource = sourceManifest(source);
  const bytes = archive(
    publicSource.files.map((file) => ({
      name: `${bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...bundle.manifest,
      source: publicSource,
      requirements: { ...bundle.manifest.requirements, omp },
    }),
    bytes,
  );
  return { manifest, files: readArchive(bytes, manifest) };
}

function nativeRelease(f: ConsumerFixture, selected: string, version: string): VerifiedBundle {
  const seed = join(f.root, `native-source-${selected}`);
  const native = overlayFixture(seed, join(f.root, `native-${selected}-${version}`), true, selected, version);
  nativeCacheFixture(seed, f.paths.home, native.checkout);
  const release = boundRelease(f, selected, seed);
  return repack(release.bundle, release.source, version);
}

posix.each([
  ["18.20.0", "19.0.0"],
  ["18.20.0", "19.1.2"],
  ["18.18.8", "19.0.0"],
])("rollback restores OMP %s frozen launch admission after OMP %s", async (oldVersion, newVersion) => {
  const f = fixture();
  const prior =
    oldVersion === "18.20.0"
      ? boundRelease(f, "prior")
      : { bundle: f.release("legacy").bundle, source: join(f.root, "legacy") };
  if (oldVersion === "18.18.8") extractArchive(prior.bundle.files, prior.bundle.manifest, prior.source);
  // Construct an authenticated release before installation; never modify its frozen installed source or native cache.
  for (const path of ["src", "skills/dori-mode/scripts/src"])
    cpSync(resolve(import.meta.dir, "..", path), join(prior.source, path), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "../package.json"), join(prior.source, "package.json"));
  for (const [path, expected] of frozenAdmission) {
    const bytes = readFileSync(join(import.meta.dir, "fixtures/native-rollback-controller", `${path}.txt`));
    expect(digest(bytes)).toBe(expected);
    mkdirSync(dirname(join(prior.source, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(prior.source, path), bytes, { mode: 0o600 });
  }
  chmodSync(join(prior.source, "scripts/consumer/omp"), 0o755);
  const one = await installBundle(f.paths, repack(prior.bundle, prior.source), undefined);
  const oldSource = releasePath(f.paths, one.current);
  const oldBytes = sourceManifest(oldSource);
  const oldNative = oldVersion === "18.20.0" ? nativeDirectory(oldSource, f.paths.home) : undefined;
  const oldSnapshot = oldNative
    ? { directory: oldNative, source: sourceManifest(oldNative), launcher: readFileSync(join(oldNative, "bin/omp")) }
    : undefined;
  const two = await installBundle(f.paths, nativeRelease(f, "next", newVersion), one);
  const config = readFileSync(f.paths.config);
  const newSource = verifyRelease(f.paths, two.current);
  const newBytes = sourceManifest(newSource);
  const newReceipt = readFileSync(manifestPath(f.paths, two.current));
  const newNative = nativeDirectory(newSource, f.paths.home);
  const newNativeBytes = sourceManifest(newNative);
  const newLauncher = readFileSync(join(newNative, "bin/omp"));
  const rolled = await rollbackRelease(f.paths, two);
  expect(rolled.current).toEqual(one.current);
  expect(rolled.previous).toBeUndefined();
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  expect(readlinkSync(f.paths.live)).toBe(oldSource);
  // The release path is created at runtime; a static import would test this checkout's newer controller instead.
  const frozen = await import(pathToFileURL(join(oldSource, "src/release/automatic.ts")).href);
  await expect(frozen.automaticLaunch(oldSource, f.paths.home)).resolves.toBe(oldSource);
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  // Negative control: the displaced manifest reproduces the actual disabled-update launch failure.
  saveJson(f.paths.state, { ...rolled, previous: two.current });
  try {
    await expect(frozen.automaticLaunch(oldSource, f.paths.home)).rejects.toThrow("supported runtime");
  } finally {
    saveJson(f.paths.state, rolled);
  }
  expect(sourceManifest(oldSource)).toEqual(oldBytes);
  expect(sourceManifest(newSource)).toEqual(newBytes);
  expect(verifyRelease(f.paths, two.current)).toBe(newSource);
  expect(readFileSync(manifestPath(f.paths, two.current))).toEqual(newReceipt);
  if (oldSnapshot) {
    expect(sourceManifest(oldSnapshot.directory)).toEqual(oldSnapshot.source);
    expect(readFileSync(join(oldSnapshot.directory, "bin/omp"))).toEqual(oldSnapshot.launcher);
  }
  expect(sourceManifest(newNative)).toEqual(newNativeBytes);
  expect(readFileSync(join(newNative, "bin/omp"))).toEqual(newLauncher);
  expect(readFileSync(f.paths.config)).toEqual(config);
  // The unsupported previous pointer is consumed, not replaced by a forged manifest or an executable shim.
  await expect(rollbackRelease(f.paths, rolled)).rejects.toThrow("No retained previous release");
});

posix("same-generation OMP 19 rollback retains its displaced release for redo", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, nativeRelease(f, "one", "19.0.0"), undefined);
  const two = await installBundle(f.paths, nativeRelease(f, "two", "19.1.2"), one);
  const rolled = await rollbackRelease(f.paths, two);
  expect(rolled.current).toEqual(one.current);
  expect(rolled.previous).toEqual(two.current);
  const redone = await rollbackRelease(f.paths, rolled);
  expect(redone.current).toEqual(two.current);
  expect(redone.previous).toEqual(one.current);
  expect(readAutomaticState(f.paths).enabled).toBe(false);
});
