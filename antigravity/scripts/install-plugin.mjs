import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = resolve(__dirname, "..");

export const REPO_NOTICE_FILES = ["LICENSE", "LICENSE.omp-dori", "LICENSING.md", "NOTICE"];
export const ATTRIBUTION_FILE_RE =
  /^(?:(?:[\w-]+[-_.])?(?:LICEN[CS]ES?|NOTICES?|COPYING|UNLICENSE|PATENTS?))(?:[._-].+)?$/i;

const SKIP_NM_DIRS = new Set(["test", "tests", "__tests__", "docs", "doc", "examples", "example", ".github"]);
const SKIP_NM_EXT = /\.(?:map|d\.ts|d\.mts|d\.cts|tsbuildinfo|md|markdown)$/i;
const SKIP_NM_NON_ATTRIBUTION_META = /^(?:CHANGELOG|HISTORY)(?:\..+)?$/i;

/**
 * Filter predicate for copying production node_modules into the standalone plugin bundle.
 * Preserves dependency LICENSE/LICENCE/NOTICE/COPYING files (including Markdown variants)
 * while stripping tests, docs, source maps, type declarations, and changelogs.
 */
export function keepRuntimeNodeModuleEntry(src) {
  const normalized = src.replace(/\\/g, "/");
  const segs = normalized.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (SKIP_NM_DIRS.has(base.toLowerCase())) return false;
  if (ATTRIBUTION_FILE_RE.test(base)) return true;
  if (SKIP_NM_EXT.test(base)) return false;
  if (SKIP_NM_NON_ATTRIBUTION_META.test(base)) return false;
  return true;
}

/**
 * Resolve only transitive production dependencies from node_modules without copying devDependencies
 * (such as typescript and @types/node) and without requiring network access.
 */
export function collectProdPackages(rootDir) {
  const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const queue = Object.keys(rootPkg.dependencies ?? {});
  const visited = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || visited.has(name)) continue;
    const pkgDir = join(rootDir, "node_modules", name);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    visited.add(name);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return [...visited].sort();
}

function measureDir(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measureDir(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += statSync(full).size;
      files++;
    }
  }
  return { bytes, files };
}

function isDistTestEntry(src) {
  const normalized = src.replace(/\\/g, "/");
  return normalized.endsWith("/dist/test") || normalized.includes("/dist/test/");
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function moveDirSync(from, to) {
  const maxAttempts = process.platform === "win32" ? 4 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (attempt < maxAttempts && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        sleepSync(50 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function resolveRepoNoticeFiles(projectRoot) {
  const searchRoots = [projectRoot, resolve(projectRoot, "..")];
  const found = [];
  for (const name of REPO_NOTICE_FILES) {
    for (const root of searchRoots) {
      const candidate = join(root, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found.push({ name, src: candidate });
        break;
      }
    }
  }
  return found;
}

function assertNonEmptyFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Bundle validation failed: missing ${label} (${filePath})`);
  }
  const st = statSync(filePath);
  if (!st.isFile() || st.size === 0) {
    throw new Error(`Bundle validation failed: empty or non-file ${label} (${filePath})`);
  }
}

export function validateInstalledBundle(bundleDir, expectedTargetDir, expectedNoticeNames = [], opts = {}) {
  for (const rel of [
    "plugin.json",
    "hooks.json",
    "package.json",
    "mcp_config.json",
    join("dist", "mcp-server.js"),
    join("dist", "cli.js"),
    join("dist", "hooks.js"),
    join("node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    join("node_modules", "zod", "package.json"),
  ]) {
    assertNonEmptyFile(join(bundleDir, rel), rel);
  }

  const requiredNotices =
    opts.requireLicense === false ? [...expectedNoticeNames] : [...new Set(["LICENSE", ...expectedNoticeNames])];
  for (const notice of requiredNotices) {
    assertNonEmptyFile(join(bundleDir, notice), notice);
  }

  const pluginManifest = JSON.parse(readFileSync(join(bundleDir, "plugin.json"), "utf8"));
  if (!pluginManifest || typeof pluginManifest.name !== "string" || !pluginManifest.name.trim()) {
    throw new Error("Bundle validation failed: plugin.json missing valid name");
  }

  const mcpConfig = JSON.parse(readFileSync(join(bundleDir, "mcp_config.json"), "utf8"));
  const expectedEntry = join(expectedTargetDir, "dist", "mcp-server.js");
  const coreServer = mcpConfig?.mcpServers?.["cataly-core"];
  if (!coreServer || coreServer.cwd !== expectedTargetDir || coreServer.args?.[0] !== expectedEntry) {
    throw new Error("Bundle validation failed: mcp_config.json does not point to target bundle");
  }
}

/**
 * Build, validate, and atomically publish a self-contained Cataly plugin bundle.
 * Stages into a sibling directory on the same volume, validates before touching any existing
 * installation, backs up the live directory during swap, and rolls back on any failure.
 */
export function installPlugin(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const pluginSourceDir = join(projectRoot, "plugin");
  const distSourceDir = join(projectRoot, "dist");
  const targetDir = resolve(
    options.targetDir ?? process.env["CATALY_PLUGIN_DIR"] ?? join(homedir(), ".gemini", "config", "plugins", "cataly"),
  );
  const quiet = Boolean(options.quiet);
  const moveDir = options.moveDir ?? moveDirSync;

  if (!existsSync(join(distSourceDir, "mcp-server.js"))) {
    throw new Error("dist/mcp-server.js not found. Run `npm run build` first.");
  }

  const parentDir = dirname(targetDir);
  mkdirSync(parentDir, { recursive: true });

  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const stagingDir = join(parentDir, `.${basename(targetDir)}.staging.${suffix}`);
  const backupDir = join(parentDir, `.${basename(targetDir)}.backup.${suffix}`);

  if (!quiet) {
    console.log(`Installing Cataly plugin to ${targetDir} ...`);
  }

  let movedTargetToBackup = false;
  let movedStagingToTarget = false;
  let prodPackages = [];
  let copiedNotices = [];

  try {
    mkdirSync(stagingDir, { recursive: true });

    // 1. Copy static plugin manifest, skills, agents, rules, hooks, assets, README
    for (const entry of ["plugin.json", "hooks.json", "README.md", "assets", "rules", "agents", "skills"]) {
      const src = join(pluginSourceDir, entry);
      const dst = join(stagingDir, entry);
      cpSync(src, dst, { recursive: true });
    }

    // 2. Copy applicable repository license and notice files (LICENSE, LICENSE.omp-dori, LICENSING.md, NOTICE)
    const repoNotices = resolveRepoNoticeFiles(projectRoot);
    for (const notice of repoNotices) {
      cpSync(notice.src, join(stagingDir, notice.name));
    }
    copiedNotices = repoNotices.map((n) => n.name);

    // 3. Copy compiled dist/ (excluding test files)
    const stagedDist = join(stagingDir, "dist");
    cpSync(distSourceDir, stagedDist, {
      recursive: true,
      filter: (src) => !isDistTestEntry(src),
    });

    // 4. Copy package.json and ONLY production dependencies (preserving attribution/license files)
    cpSync(join(projectRoot, "package.json"), join(stagingDir, "package.json"));
    const stagedNodeModules = join(stagingDir, "node_modules");
    mkdirSync(stagedNodeModules, { recursive: true });

    prodPackages = collectProdPackages(projectRoot);
    for (const pkgName of prodPackages) {
      const src = join(projectRoot, "node_modules", pkgName);
      const dst = join(stagedNodeModules, pkgName);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, filter: keepRuntimeNodeModuleEntry });
    }

    // 5. Write mcp_config.json pointing to the FINAL targetDir paths
    const mcpServerEntry = join(targetDir, "dist", "mcp-server.js");
    const mcpConfig = {
      mcpServers: {
        "cataly-core": {
          command: process.execPath,
          args: [mcpServerEntry],
          cwd: targetDir,
        },
      },
    };
    writeFileSync(join(stagingDir, "mcp_config.json"), `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");

    // 6. Validate complete staging bundle before touching any existing installation
    options.onBeforeValidate?.({ stagingDir, targetDir, backupDir });
    validateInstalledBundle(stagingDir, targetDir, copiedNotices, {
      requireLicense: options.requireLicense,
    });

    // 7. Publish replacement safely with backup + automatic rollback on swap failure
    options.onBeforeSwap?.({ stagingDir, targetDir, backupDir });
    if (existsSync(targetDir)) {
      moveDir(targetDir, backupDir);
      movedTargetToBackup = true;
    }
    options.onAfterBackup?.({ stagingDir, targetDir, backupDir });
    moveDir(stagingDir, targetDir);
    movedStagingToTarget = true;
  } catch (err) {
    let rollbackFailure = null;
    if (movedTargetToBackup && !movedStagingToTarget) {
      try {
        if (existsSync(targetDir)) {
          rmSync(targetDir, { recursive: true, force: true });
        }
        if (existsSync(backupDir)) {
          moveDir(backupDir, targetDir);
        }
      } catch (rollbackErr) {
        const origMsg = err instanceof Error ? err.message : String(err);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        rollbackFailure = new Error(
          `Plugin install failed (${origMsg}) and rollback failed (${rbMsg}) (previous bundle preserved at ${backupDir})`,
        );
      }
    }
    try {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup; never mask the primary install or rollback error
    }
    if (rollbackFailure) {
      throw rollbackFailure;
    }
    throw err;
  }

  if (movedTargetToBackup && existsSync(backupDir)) {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {
      // Live target is already published; best-effort cleanup of stale backup
    }
  }

  const mcpServerEntry = join(targetDir, "dist", "mcp-server.js");
  const stats = measureDir(targetDir);
  if (!quiet) {
    console.log("Installed Cataly plugin successfully.");
    console.log(`  Plugin dir  : ${targetDir}`);
    console.log(`  MCP server  : ${mcpServerEntry}`);
    console.log(`  Notices     : ${copiedNotices.join(", ") || "(none)"}`);
    console.log(`  Prod deps   : ${prodPackages.length} packages`);
    console.log(`  Bundle size : ${(stats.bytes / (1024 * 1024)).toFixed(2)} MB (${stats.files} files)`);
  }

  return {
    targetDir,
    mcpServerEntry,
    prodPackages,
    copiedNotices,
    stats,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    installPlugin();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
