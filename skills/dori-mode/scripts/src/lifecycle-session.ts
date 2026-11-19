import { createReadStream, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import type { Lane } from "./registry.ts";
import { sessionDirFor, sessionFileStart } from "./session-id.ts";

/** Resolve an exact saved session, not OMP's interactive/partial-id resume selector. */
export const resumeFile = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  try {
    return await readResumeFile(deps, lane);
  } catch (error) {
    if (error instanceof LaunchError) throw error;
    throw new LaunchError(
      `lane ${lane.key} saved session or cwd unavailable (${(error as NodeJS.ErrnoException).code ?? "invalid session header"})`,
    );
  }
};

const readResumeFile = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  if (!lane.session) throw new LaunchError(`lane ${lane.key} has no recorded session; sync it before parking`);
  let file = lane.sessionFile;
  if (!file) {
    const dir = sessionDirFor(deps.config.sessionsDir, lane.cwd ?? deps.config.defaultCwd);
    const matches = readdirSync(dir).filter((name) => sessionFileStart(name)?.id === lane.session);
    if (matches.length !== 1) throw new LaunchError(`lane ${lane.key} has no unique saved session file`);
    file = join(dir, matches[0] ?? "");
  }
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown };
      if (
        header.type !== "session" ||
        header.id !== lane.session ||
        typeof header.cwd !== "string" ||
        realpathSync(header.cwd) !== realpathSync(lane.cwd ?? deps.config.defaultCwd)
      )
        throw new LaunchError(`lane ${lane.key} saved session identity or cwd differs`);
      return realpathSync(file);
    }
    throw new LaunchError(`lane ${lane.key} saved session is empty`);
  } finally {
    lines.close();
    stream.destroy();
  }
};
