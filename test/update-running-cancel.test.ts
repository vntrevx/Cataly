import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { inspectActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { captureRuntime, nativeCli } from "../src/update/deployment-native.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";
import { waitFor } from "./update-detection-setup.ts";

test.skipIf(process.platform !== "linux")(
  "abort stops the active Git verification group, not the native runtime",
  async () => {
    const f = await managedBashFixture();
    const overlay = overlayFixture(f.record.releasePath, join(f.root, "ulw"));
    const marker = join(f.root, "filter-pid");
    const filter = join(f.root, "filter.ts");
    // A real Git filter holds its OS pipe; fake timers cannot expose a blocked synchronous parent.
    writeFileSync(
      filter,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
await Bun.sleep(1_000);
process.stdout.write(await Bun.stdin.text());
`,
    );
    fixtureGit(
      overlay.checkout,
      "config",
      "filter.hold.clean",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`,
    );
    fixtureGit(overlay.checkout, "config", "filter.hold.required", "true");
    writeFileSync(join(overlay.checkout, ".git/info/attributes"), "presets.ts filter=hold\n");
    const runtime = await captureRuntime(f.config, nativeCli(f.config), true);
    saveActiveDeployment(f.config, {
      ...f.record,
      runtime,
      sourceHash: sourceManifest(f.record.releasePath).hash,
      toolchain: {
        ...f.record.toolchain!,
        ompUlw: {
          source: f.record.releasePath,
          directory: overlay.checkout,
          identity: readSourceBundle(f.record.releasePath).identity,
        },
      },
    });
    const active = join(f.config.releaseRoot, "active.json");
    const before = readFileSync(active, "utf8");
    const abort = new AbortController();
    const previousTemp = process.env["TMPDIR"];
    process.env["TMPDIR"] = f.root;
    const pending = inspectActiveDeployment(f.config, abort.signal);
    try {
      await waitFor(() => existsSync(marker));
      expect(readdirSync(f.root).filter((name) => name.startsWith("dori-status-"))).toHaveLength(1);
      const pid = Number(readFileSync(marker, "utf8"));
      abort.abort();
      const result = await pending;
      expect(result.status).toBe("unknown");
      expect(result).not.toHaveProperty("sourceHash");
      expect(processIdentity(pid)).toBeUndefined();
      expect(readdirSync(f.root).filter((name) => name.startsWith("dori-status-"))).toHaveLength(0);
      expect(readFileSync(active, "utf8")).toBe(before);
      expect(sameProcess(runtime)).toBe(true);
      expect(existsSync(f.signalPath)).toBe(false);
      expect(existsSync(f.effect)).toBe(false);
    } finally {
      abort.abort();
      await pending;
      if (previousTemp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTemp;
    }
  },
);
