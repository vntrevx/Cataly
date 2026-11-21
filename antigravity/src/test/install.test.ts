import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(projectRoot, "..");
const installerScriptPath = join(projectRoot, "scripts", "install-plugin.mjs");

type InstallPluginOptions = {
  readonly projectRoot?: string;
  readonly targetDir?: string;
  readonly quiet?: boolean;
  readonly requireLicense?: boolean;
  readonly moveDir?: (from: string, to: string) => void;
  readonly onBeforeValidate?: (ctx: { stagingDir: string; targetDir: string; backupDir: string }) => void;
  readonly onBeforeSwap?: (ctx: { stagingDir: string; targetDir: string; backupDir: string }) => void;
  readonly onAfterBackup?: (ctx: { stagingDir: string; targetDir: string; backupDir: string }) => void;
};

type InstallPluginResult = {
  readonly targetDir: string;
  readonly mcpServerEntry: string;
  readonly prodPackages: readonly string[];
  readonly copiedNotices: readonly string[];
  readonly stats: { readonly bytes: number; readonly files: number };
};

type InstallerModule = {
  readonly ATTRIBUTION_FILE_RE: RegExp;
  readonly REPO_NOTICE_FILES: readonly string[];
  readonly keepRuntimeNodeModuleEntry: (src: string) => boolean;
  readonly collectProdPackages: (rootDir: string) => string[];
  readonly installPlugin: (options?: InstallPluginOptions) => InstallPluginResult;
};

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-install-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function loadInstaller(): Promise<InstallerModule> {
  return (await import(pathToFileURL(installerScriptPath).href)) as unknown as InstallerModule;
}

function listAttributionFiles(dir: string, relBase = ""): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (["test", "tests", "__tests__", "docs", "doc", "examples", "example", ".github"].includes(lower)) {
        continue;
      }
      found.push(...listAttributionFiles(full, rel));
    } else if (entry.isFile() && /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[._-].+)?$/i.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(resolveClose, 2000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.kill();
  });
}

async function smokeTestInstalledMcpServer(installedDir: string): Promise<readonly string[]> {
  const mcpConfigPath = join(installedDir, "mcp_config.json");
  const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
    mcpServers?: {
      "cataly-core"?: {
        command?: string;
        args?: string[];
        cwd?: string;
      };
    };
  };
  const core = mcpConfig.mcpServers?.["cataly-core"];
  assert.ok(core?.command, "mcp_config.json missing command");
  assert.ok(core?.args?.[0], "mcp_config.json missing server entry arg");
  assert.equal(core.cwd, installedDir);
  assert.equal(core.args[0], join(installedDir, "dist", "mcp-server.js"));

  const catalyHome = makeTempDir("cataly-installed-home-");
  const child = spawn(core.command, core.args, {
    cwd: core.cwd,
    env: { ...process.env, CATALY_HOME: catalyHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  const responses = new Map<number, unknown>();
  const waiters = new Map<number, (val: unknown) => void>();

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number") {
        const waiter = waiters.get(msg.id);
        if (waiter) {
          waiters.delete(msg.id);
          waiter(msg);
        } else {
          responses.set(msg.id, msg);
        }
      }
    }
  });

  const rpc = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}; stderr=${stderr}`)), 7000);
      const onMsg = (v: unknown) => {
        clearTimeout(timer);
        resolvePromise(v as Record<string, unknown>);
      };
      if (responses.has(id)) {
        onMsg(responses.get(id));
      } else {
        waiters.set(id, onMsg);
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initRes = await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "install-smoke-client", version: "1.0.0" },
    });
    assert.ok(initRes["result"], "installed MCP server initialize should return result");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listRes = (await rpc(2, "tools/list")) as { result?: { tools?: { name: string }[] } };
    const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes("cataly_boot"));
    assert.ok(toolNames.includes("cataly_board_post"));
    assert.ok(toolNames.includes("cataly_board_read"));
    assert.ok(toolNames.length >= 42, `expected >=42 tools, got ${toolNames.length}`);

    const bootRes = (await rpc(3, "tools/call", { name: "cataly_boot", arguments: {} })) as {
      result?: { content?: { text?: string }[] };
    };
    assert.match(bootRes.result?.content?.[0]?.text ?? "", /CATALY BOOT/);

    return toolNames;
  } finally {
    await stopChildProcess(child);
  }
}

describe("plugin installer attribution preservation, installed-bundle MCP smoke test, and atomic rollback", () => {
  it("preserves upstream repo notices and dependency LICENSE/LICENCE/NOTICE (including .md) in a clean install and boots the installed MCP server", async () => {
    const installer = await loadInstaller();
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/LICENSE"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/LICENSE.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/license.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/LICENCE.txt"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/NOTICE"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/NOTICE.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/NOTICES.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/THIRD-PARTY-NOTICES.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/MIT-LICENSE.md"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/UNLICENSE"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/PATENTS"), true);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/README.md"), false);
    assert.equal(installer.keepRuntimeNodeModuleEntry("/pkg/CHANGELOG.md"), false);

    const sandbox = makeTempDir("cataly-clean-install-");
    const targetDir = join(sandbox, "cataly-plugin");

    execFileSync(process.execPath, [installerScriptPath], {
      cwd: projectRoot,
      env: { ...process.env, CATALY_PLUGIN_DIR: targetDir },
      encoding: "utf8",
    });

    // 1. Repository-level license & notice files are preserved verbatim
    for (const notice of installer.REPO_NOTICE_FILES) {
      const upstreamPath = join(repoRoot, notice);
      if (existsSync(upstreamPath)) {
        const installedPath = join(targetDir, notice);
        assert.equal(existsSync(installedPath), true, `expected installed bundle to include ${notice}`);
        assert.equal(readFileSync(installedPath, "utf8"), readFileSync(upstreamPath, "utf8"));
      }
    }

    // 2. Test files are excluded from installed dist/
    assert.equal(existsSync(join(targetDir, "dist", "test")), false, "dist/test must not be bundled");

    // 3. Every production dependency's LICENSE/LICENCE/NOTICE file (including Markdown variants) is preserved
    const prodPkgs = installer.collectProdPackages(projectRoot);
    let checkedMarkdownLicense = false;
    let checkedExtensionlessLicense = false;
    for (const pkgName of prodPkgs) {
      const srcPkgDir = join(projectRoot, "node_modules", pkgName);
      const dstPkgDir = join(targetDir, "node_modules", pkgName);
      const srcLicenses = listAttributionFiles(srcPkgDir);
      for (const rel of srcLicenses) {
        const dstFile = join(dstPkgDir, rel);
        assert.equal(existsSync(dstFile), true, `missing preserved dependency attribution file: ${pkgName}/${rel}`);
        if (/\.md$/i.test(rel)) checkedMarkdownLicense = true;
        if (!rel.includes(".")) checkedExtensionlessLicense = true;
      }
    }
    assert.equal(checkedExtensionlessLicense, true, "expected at least one extensionless dependency LICENSE file");
    assert.equal(checkedMarkdownLicense, true, "expected at least one Markdown dependency LICENSE.md file");

    // 4. Smoke-test the INSTALLED bundle's MCP server (NOT the checkout's dist/)
    await smokeTestInstalledMcpServer(targetDir);

    // 5. No leftover staging or backup siblings
    const siblings = readdirSync(sandbox);
    assert.deepEqual(siblings, ["cataly-plugin"]);
  });

  it("keeps an existing working installation intact when an upgrade fails during staging or mid-swap rollback", async () => {
    const installer = await loadInstaller();
    const sandbox = makeTempDir("cataly-rollback-");
    const targetDir = join(sandbox, "cataly-plugin");

    // Initial working installation
    installer.installPlugin({ projectRoot, targetDir, quiet: true });
    const sentinelPath = join(targetDir, ".previous-install-sentinel");
    writeFileSync(sentinelPath, "v1-intact\n", "utf8");

    // Case 1: Failure during staging before touching targetDir
    assert.throws(
      () =>
        installer.installPlugin({
          projectRoot,
          targetDir,
          quiet: true,
          onBeforeValidate: () => {
            throw new Error("simulated staging interruption");
          },
        }),
      /simulated staging interruption/,
    );

    assert.equal(readFileSync(sentinelPath, "utf8"), "v1-intact\n", "staging failure must not mutate live targetDir");
    assert.deepEqual(readdirSync(sandbox), ["cataly-plugin"], "staging dir must be cleaned up on staging failure");
    await smokeTestInstalledMcpServer(targetDir);

    // Case 2: Failure AFTER moving live targetDir -> backupDir (simulates mid-swap failure)
    assert.throws(
      () =>
        installer.installPlugin({
          projectRoot,
          targetDir,
          quiet: true,
          onAfterBackup: () => {
            throw new Error("simulated swap failure");
          },
        }),
      /simulated swap failure/,
    );

    assert.equal(
      readFileSync(sentinelPath, "utf8"),
      "v1-intact\n",
      "swap failure must roll back previous installation",
    );
    assert.deepEqual(readdirSync(sandbox), ["cataly-plugin"], "rollback must leave no staging or backup leftovers");
    await smokeTestInstalledMcpServer(targetDir);

    // Case 2b: Failure inside moveDir on the 2nd rename (stagingDir -> targetDir) triggers full rollback
    let moveCalls = 0;
    assert.throws(
      () =>
        installer.installPlugin({
          projectRoot,
          targetDir,
          quiet: true,
          moveDir: (from, to) => {
            moveCalls++;
            if (moveCalls === 2) {
              throw new Error("simulated rename staging->target EBUSY");
            }
            renameSync(from, to);
          },
        }),
      /simulated rename staging->target EBUSY/,
    );
    assert.equal(moveCalls, 3, "expected backup rename, failed publish rename, and rollback rename");
    assert.equal(readFileSync(sentinelPath, "utf8"), "v1-intact\n", "failed publish rename must roll back v1");
    assert.deepEqual(readdirSync(sandbox), ["cataly-plugin"], "rollback after failed rename must clean up siblings");
    await smokeTestInstalledMcpServer(targetDir);

    // Case 3: Subsequent clean upgrade succeeds and replaces previous installation cleanly
    installer.installPlugin({ projectRoot, targetDir, quiet: true });
    assert.equal(existsSync(sentinelPath), false, "clean upgrade should replace old directory cleanly");
    assert.deepEqual(readdirSync(sandbox), ["cataly-plugin"], "clean upgrade must remove backup directory");
    await smokeTestInstalledMcpServer(targetDir);
  });
});
