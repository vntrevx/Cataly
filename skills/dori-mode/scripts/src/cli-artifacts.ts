import { Artifacts } from "./artifacts.ts";
import { Checkpoints } from "./checkpoints.ts";
import { type Command, die } from "./cli-context.ts";

export const artifactCommands: Readonly<Record<string, Command>> = {
  artifact: async ({ positionals, values, opt, need, config, deps }) => {
    if (values["public"] !== undefined && typeof values["public"] !== "boolean") die("--public does not take a value");
    const operation = positionals[0];
    const key = positionals[1] || die("artifact needs a lane key");
    const value = positionals[2] || die("artifact needs a file path or id");
    if (positionals.length !== 3) die("artifact needs add <key> <path> or delivered <key> <id>");
    const artifacts = new Artifacts(config, deps.registry);
    if (operation === "add")
      console.log(
        JSON.stringify(
          await artifacts.add(
            key,
            value,
            opt("title"),
            values["public"] === true ? "public" : "private",
            deps.clock.now(),
          ),
        ),
      );
    else if (operation === "delivered")
      console.log(JSON.stringify(artifacts.delivered(key, value, need("sha256"), need("receipt"), deps.clock.now())));
    else die("artifact needs add or delivered");
  },
  artifacts: async ({ key: requested, positionals, values, config, deps }) => {
    if (values["json"] !== undefined && typeof values["json"] !== "boolean") die("--json does not take a value");
    const key = requested || die("artifacts needs a lane key");
    if (positionals.length !== 1 || !(await deps.registry.read(key)))
      die("artifacts needs one registered lane key (open or closed)");
    const artifacts = await new Artifacts(config, deps.registry).views(key);
    const checkpoints = new Checkpoints(config.stateDir).read(key);
    const entries = artifacts.map((entry) => ({
      ...entry,
      checkpoints: checkpoints.flatMap((checkpoint) =>
        checkpoint.evidence
          .filter((evidence) =>
            entry.versions.some((version) => evidence === `artifact:${entry.id}@sha256:${version.sha256}`),
          )
          .map((evidence) => ({ step: checkpoint.step, at: checkpoint.at, evidence })),
      ),
    }));
    if (values["json"] === true) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (!entries.length) {
      console.log(`ARTIFACTS ${key} none registered`);
      return;
    }
    for (const entry of entries) {
      const last = entry.versions.at(-1);
      console.log(`ARTIFACT ${entry.id} ${JSON.stringify(last?.title)} ${last?.visibility} ${entry.state}`);
      console.log(`  file=${JSON.stringify(entry.path)} registered=${entry.createdAt}`);
      console.log(`  registered-sha256=${last?.sha256} current-sha256=${entry.current?.sha256 ?? "unknown"}`);
      console.log(`  registered-url=${last?.url ?? "none"} current-url=${entry.current?.url ?? "none"}`);
      if (entry.problem) console.log(`  problem=${entry.problem}`);
      for (const version of entry.versions)
        console.log(
          `  version sha256=${version.sha256} at=${version.at} ${version.visibility} url=${version.url ?? "none"}`,
        );
      for (const receipt of entry.receipts)
        console.log(
          `  delivery=${receipt.kind} sha256=${receipt.sha256} at=${receipt.at} receipt=${JSON.stringify(receipt.reference)}`,
        );
      for (const checkpoint of entry.checkpoints)
        console.log(`  checkpoint=${JSON.stringify(checkpoint.step)} ${checkpoint.evidence}`);
      console.log(`  delivery-receipts=${entry.receipts.length} HTTP=not-checked viewed=unknown`);
    }
  },
};
