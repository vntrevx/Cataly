import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { digest } from "../src/update/source.ts";
import { loadSourceUpdateConfig } from "../src/update/source-update-config.ts";
import { nativeUiConsumerFixture } from "./update-deploy-native-ui-consumer-setup.ts";
import { gitSourceFixture } from "./update-source-git-setup.ts";

/** The native pane API is recorded; Git, Bun, intake leases, process replacement and health files are real. */
export async function sourceRolloutFixture(outcome: "delayed" | "late" | "undelivered" = "delayed") {
  const native = await nativeUiConsumerFixture(outcome, { activity: true });
  try {
    const git = Bun.which("git");
    if (!git) throw new Error("source rollout tests require Git");
    const path = join(native.root, "source-update.json");
    const settings = {
      version: 1,
      git,
      gh: process.execPath,
      activityFiles: [join(native.config.stateDir, "activity", "discord.json")],
      deployment: native.config,
    };
    saveDeploymentJson(path, settings);
    const f = await gitSourceFixture({ root: native.root, path, settings, config: loadSourceUpdateConfig(path) });
    // Managed prepareRelease also resolves its Git through the private Bun directory.
    const bun = join(dirname(f.config.git), "bun");
    symlinkSync(process.execPath, bun);
    saveDeploymentJson(path, { ...f.settings, deployment: { ...f.config.deployment, bun } });
    const config = loadSourceUpdateConfig(path);
    const omp = config.deployment.omp!;
    const input = [
      'const input = new (await import("node:stream")).PassThrough();',
      'const uiFs = await import("node:fs");',
      `const uiRequests = ${JSON.stringify(native.requests)};`,
      `const uiTrace = ${JSON.stringify(join(native.root, "native-ui-events"))};`,
      "const trace = event => uiFs.appendFileSync(uiTrace, JSON.stringify({ pid: process.pid, event }) + String.fromCharCode(10));",
      'let handledKeys = uiFs.readFileSync(uiRequests, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean).length;',
      "const uiWatch = uiFs.watch(uiRequests, () => {",
      '  const lines = uiFs.readFileSync(uiRequests, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean);',
      '  for (const line of lines.slice(handledKeys)) if (JSON.parse(line).kind === "key") { trace("key"); input.end(); }',
      "  handledKeys = lines.length;",
      "});",
      'input.once("end", () => { trace("input-end"); uiWatch.close(); process.stdin.destroy(); });',
      'process.stdin.once("end", () => input.end()); process.stdin.resume();',
    ].join("\n");
    const program = readFileSync(omp, "utf8")
      .replace("\n", '\nif (process.argv.includes("--version")) { console.log("18.18.8"); process.exit(0); }\n')
      .replace("const input = process.stdin;", input)
      .replace("\nawait stopChildren();\n", '\nawait stopChildren(); trace("children-closed");\n');
    writeFileSync(omp, program);
    const sourceState = join(config.deployment.releaseRoot, "source-update.json");
    const pending = JSON.stringify(join(config.deployment.releaseRoot, "restart-pending.json"));
    const journal = `(await Bun.file(${pending}).exists() ? JSON.parse(readFileSync(${pending}, "utf8")).directory : JSON.parse(readFileSync(${JSON.stringify(sourceState)}, "utf8")).job.deployment.directory) + "/deployment.json"`;
    const paneCli = config.deployment.herdr!;
    const paneProgram = readFileSync(paneCli, "utf8");
    if (!paneProgram.includes(JSON.stringify(native.journal)))
      throw new Error("native fixture journal boundary changed");
    writeFileSync(paneCli, paneProgram.replace(JSON.stringify(native.journal), journal));
    native.writeHealth({
      ...native.health,
      extensionHash: digest(readFileSync(join(config.deployment.liveSource, "extension/index.ts"))),
      updatedAt: new Date().toISOString(),
    });
    rmSync(join(config.deployment.releaseRoot, "restart-pending.json"));
    return {
      ...native,
      ...f,
      config,
      activity: settings.activityFiles[0]!,
      sourceState,
      nativeRequests: native.requests,
      readNativeRequests: () =>
        readFileSync(native.requests, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind: string; line: string }),
    };
  } catch (error) {
    native.closeRequests();
    throw error;
  }
}
