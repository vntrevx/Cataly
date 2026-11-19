import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { loadSourceUpdateConfig } from "../src/update/source-update-config.ts";
import { fixture } from "./update-deploy-setup.ts";

export function sourceFixture() {
  const f = fixture();
  const git = Bun.which("git");
  if (!git) throw new Error("source update tests require Git");
  const path = join(f.root, "source-update.json");
  const settings = {
    version: 1,
    git,
    // Pure policy tests supply GitHubReads; CLI tests replace this executable with their recorded API transport.
    gh: process.execPath,
    activityFiles: [join(f.config.stateDir, "activity", "discord.json")],
    deployment: f.config,
  };
  saveDeploymentJson(path, settings);
  return { root: f.root, path, settings, config: loadSourceUpdateConfig(path) };
}
