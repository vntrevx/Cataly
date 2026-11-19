import { copyFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { command } from "../update/deployment-process.ts";
import { regularFile } from "./files.ts";
import { bundleEnv } from "./source-bundle.ts";

/** Copy the version-matched official addon, then prove the protected source selects that exact file. */
export async function bindOfficialNativeAddon(
  stage: string,
  checkout: string,
  home: string,
  bun: string,
  version: string,
): Promise<string> {
  const modules = join(stage, "addon/node_modules");
  const natives = join(stage, "natives");
  const code = `const m = await import(process.argv[1]); const b = m.loadNative();
if (typeof b.__piNativesBuildVersion !== "function" || b.__piNativesBuildVersion() !== ${JSON.stringify(version)}) throw new Error("official native addon version differs");
const s = m.nativeAddonStatus(); if (!s || s.version !== ${JSON.stringify(version)} || s.stale) throw new Error("native addon identity unavailable"); console.log(s.path);`;
  const env = { ...bundleEnv(home, bun), PI_NATIVES_DIR: natives };
  const probe = (loader: string) => command([bun, "-e", code, loader], stage, env, 60_000);
  const official = await probe(join(modules, "@oh-my-pi/pi-natives/native/loader-state.js"));
  if (
    !regularFile(official) ||
    !realpathSync(official).startsWith(`${realpathSync(modules)}/`) ||
    !official.endsWith(".node")
  )
    throw new Error("Official native package resolved an addon outside its frozen install");
  const target = join(checkout, "packages/natives/native", basename(official));
  copyFileSync(official, target);
  if (resolve(await probe(join(checkout, "packages/natives/native/loader-state.js"))) !== target)
    throw new Error("Bound source did not load the exact version-matched official addon");
  return target;
}
