import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSourceUpdateConfig } from "../src/update/source-update-config.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { githubFixture } from "./release-producer-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { git } from "./update-setup.ts";
import { sourceFixture } from "./update-source-setup.ts";

/** Real clean Git history and clones; only the GitHub transport is recorded, with no network/model calls. */
export async function gitSourceFixture(f = sourceFixture()) {
  const source = f.config.deployment.liveSource;
  const prepared = preparationFixture();
  for (const file of prepared.input.publicManifest.files) {
    const path = join(source, file.path);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(prepared.remote, file.path), path);
  }
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  chmodSync(source, 0o700);
  git(source, "init", "-b", "main");
  chmodSync(join(source, ".git"), 0o700);
  git(source, "config", "user.name", "Source update fixture");
  git(source, "config", "user.email", "source@example.invalid");
  git(source, "add", ".");
  git(source, "commit", "-m", "Installed source fixture");
  const currentCommit = git(source, "rev-parse", "HEAD");
  const remote = join(f.root, "source-remote");
  git(f.root, "clone", "--no-local", source, remote);
  writeFileSync(join(remote, "src/app.ts"), "export const release = 'incoming';\n");
  git(
    remote,
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "-am",
    "Incoming source fixture",
  );
  const commit = git(remote, "rev-parse", "HEAD"),
    tree = git(remote, "rev-parse", "HEAD^{tree}");
  const tools = join(f.root, "source-tools");
  mkdirSync(tools);
  const gitPath = join(tools, "git"),
    ghPath = join(tools, "gh");
  const requests = join(f.root, "github-requests.jsonl"),
    responsesPath = join(f.root, "github-responses.json");
  const unavailable = join(f.root, "github-unavailable");
  writeFileSync(
    gitPath,
    `#!${process.execPath}
const child = Bun.spawn([${JSON.stringify(f.config.git)}, "-c", ${JSON.stringify(`url.${remote}.insteadOf=https://github.com/${f.config.repository}.git`)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    ghPath,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME,
  leaked: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"].filter(key => key in process.env) }) + "\\n");
if (existsSync(${JSON.stringify(unavailable)})) process.exit(71);
const values = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, "utf8"));
const path = process.argv[3];
if (process.argv[2] !== "api" || !Object.hasOwn(values, path)) throw new Error("Unrecorded GitHub boundary: " + path);
console.log(JSON.stringify(process.argv.includes("--paginate") ? [values[path]] : values[path]));
`,
    { mode: 0o700 },
  );
  const gh = githubFixture(f.config.repository);
  const responses: Record<string, unknown> = JSON.parse(
    JSON.stringify(gh.responses).replaceAll(gh.manifest.commit, commit).replaceAll(gh.manifest.tree, tree),
  );
  const rewrite = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(gh.manifest.commit, commit));
  const prefix = `repos/${f.config.repository}`;
  responses[`${prefix}/git/commits/${commit}`] = {
    sha: commit,
    tree: { sha: tree },
    parents: [{ sha: currentCommit }],
  };
  responses[`${prefix}/compare/${currentCommit}...${commit}`] = {
    status: "ahead",
    ahead_by: 1,
    base_commit: { sha: currentCommit },
    merge_base_commit: { sha: currentCommit },
  };
  responses[`${prefix}/actions/workflows/50/runs?head_sha=${commit}&event=push&per_page=100`] = {
    workflow_runs: rewrite(gh.runs),
  };
  responses[`${prefix}/actions/runs/70/attempts/2/jobs?per_page=100`] = { jobs: rewrite(gh.jobs) };
  saveDeploymentJson(responsesPath, responses);
  const settings = { ...f.settings, git: gitPath, gh: ghPath, deployment: f.config.deployment };
  saveDeploymentJson(f.path, settings);
  const config = loadSourceUpdateConfig(f.path);
  const current = await currentSource(config);
  const target = { commit, tree, main: commit, ahead: 1, ci: { id: 70, attempt: 2 } };
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts"),
        ...args,
        "--config",
        f.path,
      ],
      {
        env: {
          HOME: config.deployment.home,
          PATH: process.env["PATH"],
          DORI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
          OPENAI_API_KEY: "unusable-source-test",
          ANTHROPIC_API_KEY: "unusable-source-test",
          GH_TOKEN: "unusable-source-test",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return {
    ...f,
    config,
    settings,
    source,
    remote,
    current,
    target,
    requests,
    responses,
    responsesPath,
    unavailable,
    cli,
    readRequests: () =>
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; home: string; leaked: string[] }),
  };
}
