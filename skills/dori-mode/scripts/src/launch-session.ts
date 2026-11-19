import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { type CreateSpec, formatRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { quoteForPane } from "./launch-footer.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { type Lane, type Registry, sessionFields } from "./registry.ts";
import type { ChosenRuntimes } from "./run.ts";

export type OpenedLane =
  | { readonly kind: "opened"; readonly lane: Lane; readonly ref: SessionRef }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly what: string; readonly error: unknown };

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bind the private route only to this launch, not its shell or a later OMP session in the same pane. */
export const laneStartCommand = (lane: Pick<Lane, "key" | "thread">, argv: readonly string[]): string => {
  const prefix =
    lane.thread.startsWith("discord:") && isDiscordSnowflake(lane.thread.slice("discord:".length))
      ? `CATALY_ASK_LAUNCHED_LANE=${quoteForPane(lane.key)} `
      : "";
  return `${prefix}${argv.map(quoteForPane).join(" ")}`;
};

// Each cleanup step is tried on its own: one that fails is reported and never stops the others.
const removeStaged = (staged: string): void => {
  try {
    rmSync(staged, { force: true });
  } catch (error) {
    process.stderr.write(`dori: could not remove the staged brief ${staged} (${why(error)})\n`);
  }
};

// A brief that is a link (a shared template) is written through it, as a plain write would.
const briefTarget = (brief: string): string => {
  try {
    return realpathSync(brief);
  } catch {
    return brief;
  }
};

/**
 * Opens a lane's session and registers it before its agent starts (dori report refuses an unknown key, so a fast
 * lane's first report would be lost). The brief is staged beside its path first, so a read-only brief, a full disk or
 * an unwritable directory fails before anything exists, and the brief is rewritten in place only once this launch owns
 * the key; the staged copy is then removed. A rewrite that fails puts the original bytes back. A key that another
 * launch or adopt registered meanwhile is `taken`: its record and brief stay. Whenever this launch does not open, it
 * closes the session it created and removes its staged brief and its own record.
 */
export const openLaneSession = async (
  registry: Registry,
  rts: ChosenRuntimes,
  spec: CreateSpec,
  draft: Lane,
  brief: string,
  preamble: string,
): Promise<OpenedLane> => {
  const target = briefTarget(brief);
  const staged = `${target}.${process.pid}.${randomUUID()}.launch`;
  // The original bytes, also kept beside the brief until the launch is settled: a write that fails part-way puts them
  // back, and if even that fails the copy stays where the error names it.
  const backup = `${target}.${process.pid}.${randomUUID()}.original`;
  let original: Buffer;
  try {
    accessSync(target, constants.W_OK);
    writeFileSync(staged, preamble, { flag: "wx", mode: 0o600 });
    original = readFileSync(target);
    writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  } catch (error) {
    removeStaged(staged);
    removeStaged(backup);
    return { kind: "failed", what: "brief not writable", error };
  }
  let ref: SessionRef;
  try {
    ref = await rts.default.create(spec);
  } catch (error) {
    removeStaged(staged);
    removeStaged(backup);
    return { kind: "failed", what: "session create failed", error };
  }
  const lane: Lane = { ...draft, ...sessionFields(ref) };
  let registered = false;
  let keepBackup = false;
  let failure: OpenedLane = { kind: "taken" };
  try {
    registered = await registry.create(lane);
    if (registered) {
      // Written in place, as the brief file itself: its inode, hard links, owner, group, mode and ACL stay.
      writeFileSync(target, preamble);
      removeStaged(staged);
      removeStaged(backup);
      return { kind: "opened", lane, ref };
    }
  } catch (error) {
    failure = { kind: "failed", what: "lane not registered", error };
    if (registered) {
      let reason = error;
      try {
        writeFileSync(target, original);
      } catch (restoreError) {
        keepBackup = true;
        reason = new Error(
          `${why(error)}; the original brief is kept at ${backup} (it could not be put back: ${why(restoreError)})`,
        );
      }
      failure = { kind: "failed", what: "brief not written", error: reason };
    }
  }
  removeStaged(staged);
  if (!keepBackup) removeStaged(backup);
  if (registered)
    await registry.discard(lane).catch((error: unknown) => {
      process.stderr.write(`dori: could not remove lane ${lane.key} after its launch failed (${why(error)})\n`);
    });
  await rts
    .for(ref)
    .close(ref, ref.container ? "container" : "session")
    .catch((error: unknown) => {
      process.stderr.write(
        `dori: could not close ${formatRef(ref)} after lane ${lane.key} did not open (${why(error)})\n`,
      );
    });
  return failure;
};
