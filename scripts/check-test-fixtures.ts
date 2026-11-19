import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { type NativeCliProbe, probeNativeCli } from "../src/runtime/omp-capabilities.ts";
import { assertNativeHost, type NativeHostEvidence } from "../test/fixtures/omp-native-host/host.ts";

/** Require the exact host and its public CLI/API; native behavior remains the integration tests' responsibility. */
export async function checkTestFixtures(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ native: NativeHostEvidence; cli: NativeCliProbe }> {
  for (const [name, entry] of [
    ["bound ULW fixture", join(root, "ref/omp-ulw/index.ts")],
    ["DORI_TEST_COMPAT_ULW_ENTRY", env["DORI_TEST_COMPAT_ULW_ENTRY"]],
  ] as const) {
    if (!entry || !isAbsolute(entry) || !statSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${name} must name an existing absolute fixture file`);
    }
  }
  const native = await assertNativeHost(env);
  const cli = await probeNativeCli([process.execPath, native.entry], root, env, native.nativeVersion);
  if (cli.reason)
    throw new Error(
      `native CLI executable=${JSON.stringify(cli.executable)} entry=${JSON.stringify(native.entry)}: ${cli.reason}`,
    );
  return { native, cli };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const { native, cli } = await checkTestFixtures(root);
    const expected = readSourceBundle(root, true).lock;
    console.log(
      `CI_FIXTURES_OK native=${native.nativeVersion} executable=${JSON.stringify(cli.realpath)} ` +
        `entry=${JSON.stringify(cli.entry)} expectedRevision=${expected.commit} observedRevision=unknown ` +
        `publicCLI=PASS publicAPI=PASS(${native.publicAPI.join(",")}) ulw=present compatibility=present; ` +
        "package revision is not attested; not live messenger compatibility",
    );
  } catch (error) {
    console.error(`CI_FIXTURES_FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Prepare the exact fixtures in CONTRIBUTING.md#run-the-gates before running the full gate.");
    process.exitCode = 1;
  }
}
