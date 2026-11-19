import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NativeHostEvidence = {
  readonly root: string;
  readonly entry: string;
  readonly nativeVersion: string;
  readonly publicAPI: readonly string[];
};

export async function assertNativeHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<NativeHostEvidence> {
  const host = env["DORI_TEST_OMP_ROOT"];
  if (!host || !isAbsolute(host)) throw new Error("DORI_TEST_OMP_ROOT must name the absolute exact native OMP fixture");
  const manifest = await Bun.file(join(host, "package.json")).json();
  if (manifest.version !== "18.20.0") throw new Error(`native OMP fixture must be 18.20.0, got ${manifest.version}`);
  const publicAPI: string[] = [];
  for (const [specifier, path, features] of [
    [
      "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader",
      "src/extensibility/extensions/loader.ts",
      ["ExtensionRuntime", "loadExtensionFromFactory", "importExtensionModule"],
    ],
    [
      "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner",
      "src/extensibility/extensions/runner.ts",
      ["ExtensionRunner", "emitSessionShutdownEvent"],
    ],
    ["@oh-my-pi/pi-coding-agent/config/settings", "src/config/settings.ts", ["Settings.isolated"]],
    ["@oh-my-pi/pi-coding-agent/session/session-manager", "src/session/session-manager.ts", ["SessionManager.inMemory"]],
    ["@oh-my-pi/pi-coding-agent/utils/event-bus", "src/utils/event-bus.ts", ["EventBus"]],
  ] as const) {
    const resolved = import.meta.resolve(specifier);
    const modulePath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    const actual = realpathSync(modulePath);
    if (actual !== realpathSync(join(host, path)))
      throw new Error(`native prompt guard imported ${specifier} at ${actual} outside DORI_TEST_OMP_ROOT=${host}`);
    const module = await import(actual);
    for (const feature of features) {
      let value: unknown = module;
      for (const part of feature.split("."))
        value = value !== null && (typeof value === "object" || typeof value === "function")
          ? Reflect.get(value, part)
          : undefined;
      if (typeof value !== "function") throw new Error(`missing public native API ${feature} at ${actual}`);
      publicAPI.push(feature);
    }
  }
  return {
    root: realpathSync(host),
    entry: join(host, "dist/cli.js"),
    nativeVersion: manifest.version,
    publicAPI,
  };
}
