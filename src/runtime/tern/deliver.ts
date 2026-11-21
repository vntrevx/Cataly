import type { Exec } from "../exec.ts";
import { joinWrapped } from "../hc/deliver.ts";
import { ENTER_ATTEMPTS, identity, PASTE_SETTLE_MS, type Sleep, sameAgent } from "../herdr/deliver.ts";
import type { AgentIdentity, DeliverOptions, DeliverOutcome, Key, Probe, SubmitResult } from "../types.ts";
import { layout } from "./blocks.ts";
import { isMissing, TernError, ternCall } from "./exec.ts";
import { ompDraft, probe } from "./probe.ts";

/** Screen reads after each Enter, SUBMIT_CHECK_MS apart, looking for the input to be empty again. */
export const SUBMIT_CHECKS = 5;
export const SUBMIT_CHECK_MS = 300;
/** Rows read to find the input: it sits at the bottom of the screen, under at most a long draft. */
const INPUT_ROWS = 60;

const KEY_NAMES: Readonly<Record<Key, string>> = { enter: "enter", escape: "esc" };
const NO_AGENT: DeliverOutcome = { kind: "no-agent" };

/** Only a live agent with nothing in front of it may get keystrokes. */
const typable = (seen: Probe): boolean =>
  !seen.shellInFront &&
  !seen.approvalPending &&
  seen.status !== "gone" &&
  seen.status !== "shell" &&
  seen.status !== "unknown" &&
  seen.status !== "blocked" &&
  seen.status !== "error";

/** The draft in the block's input; undefined when the screen cannot be read or shows no input `ompDraft` knows. */
async function draftOf(exec: Exec, id: string): Promise<string | undefined> {
  try {
    return ompDraft(await read(exec, id, INPUT_ROWS));
  } catch {
    return undefined;
  }
}

/**
 * Delivers one message as one argv element (nothing is expanded by a shell). Probe first: a shell in front is
 * `no-agent` whatever the status says (#66); an approval, an agent Tern cannot read, or a status other than `when`
 * holds the message (`not-ready`), and so does a draft seen in the input: Tern has no call that types into an agent, so
 * Dori must not write over what a person is typing. `strictIdle` accepts only `idle`, at the first probe and again
 * before each Enter. The text is pasted (bracketed, so a line break never submits early) and Enter submits it. A
 * failed paste may have typed some of it: `ambiguous` (#89). Text left in the input is `typed` (#108).
 */
export async function deliver(
  exec: Exec,
  id: string,
  text: string,
  sleep: Sleep,
  opts: DeliverOptions = {},
  stateDir?: string,
): Promise<DeliverOutcome> {
  const { when = "idle", expectedSessionId, strictIdle = false } = opts;
  let before: Probe;
  try {
    before = await probe(exec, id, stateDir);
  } catch (e) {
    process.stderr.write(
      `dori: tern probe of ${id} failed (${e instanceof Error ? e.message : String(e)}); holding delivery\n`,
    );
    return { kind: "not-ready", status: "unknown" };
  }
  if (before.status === "gone" || before.status === "shell" || before.shellInFront) return NO_AGENT;
  if (before.approvalPending) return { kind: "not-ready", status: "blocked" };
  if (expectedSessionId !== undefined && (before.pid === undefined || before.sessionId !== expectedSessionId))
    return { kind: "not-ready", status: "unknown" };
  if (!typable(before)) return { kind: "not-ready", status: before.status };
  const wanted = strictIdle
    ? ["idle"]
    : when === "idle"
      ? ["idle", "done"]
      : when === "working"
        ? ["working"]
        : ["idle", "done", "working"];
  if (!wanted.includes(before.status)) return { kind: "not-ready", status: before.status };
  const input = await draftOf(exec, id);
  if (input !== undefined && input !== "") return { kind: "not-ready", status: "unknown" };
  try {
    await ternCall(exec, ["send", id, "paste", "--", text], { redact: text });
  } catch (e) {
    if (isMissing(e)) return NO_AGENT;
    const detail = e instanceof TernError ? e.reason : "tern send paste did not complete";
    return { kind: "ambiguous", detail: `tern send paste failed: ${detail}`, failure: new Error(detail) };
  }
  await sleep(PASTE_SETTLE_MS);
  const into = identity(before);
  const missed = await submit(exec, id, into, sleep, input === "", stateDir, strictIdle);
  return missed === undefined ? { kind: "delivered" } : { kind: "typed", into, failure: missed };
}

/**
 * Presses Enter on text already in the input; returns the failure when it was not submitted. Before each press the
 * same agent must still be there with nothing in front of it, so an Enter never lands in a shell or another agent.
 * `watched`: the input was readable, so Enter is pressed only on a draft that is seen there and again until the input
 * reads empty. Otherwise (a composer `ompDraft` does not know) one Enter the tool accepts is the submit, as on herdr.
 */
async function submit(
  exec: Exec,
  id: string,
  into: AgentIdentity,
  sleep: Sleep,
  watched: boolean,
  stateDir?: string,
  strictIdle = false,
): Promise<Error | undefined> {
  for (let attempt = 1; attempt <= ENTER_ATTEMPTS; attempt++) {
    const seen = await probe(exec, id, stateDir).catch(() => undefined);
    if (seen === undefined || !typable(seen) || !sameAgent(into, seen))
      return new Error("the agent changed, left or is awaiting approval; typed text kept for reconciliation");
    const draft = watched ? await draftOf(exec, id) : undefined;
    if (watched && draft === undefined)
      return new Error("the input is no longer recognisable; typed text kept for reconciliation");
    if (draft === "") return attempt === 1 ? new Error("the pasted text never showed in the input") : undefined;
    if (strictIdle && seen.status !== "idle")
      return new Error("the agent is no longer idle; typed text kept for reconciliation");
    try {
      await ternCall(exec, ["send", id, "keys", "enter"]);
    } catch (e) {
      if (attempt === ENTER_ATTEMPTS) return e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!watched) return undefined;
    for (let check = 0; check < SUBMIT_CHECKS; check++) {
      await sleep(SUBMIT_CHECK_MS);
      if ((await draftOf(exec, id)) === "") return undefined;
    }
  }
  return new Error(`the text was still in the input after ${ENTER_ATTEMPTS} Enter presses`);
}

/**
 * Submits text an earlier deliver typed into `into` but could not submit: presses only Enter, never types it again.
 * `changed`, pressing nothing: no agent, another one (#108), or its input reads empty now (the text is not there to
 * submit). `wait`, pressing nothing: a shell or an approval is in front, or the status cannot be read. Throws when
 * Enter left the text in the input.
 */
export async function submitTyped(
  exec: Exec,
  id: string,
  into: AgentIdentity,
  sleep: Sleep,
  stateDir?: string,
): Promise<SubmitResult> {
  const seen = await probe(exec, id, stateDir);
  if (seen.status === "gone") return "wait";
  if (seen.status === "shell") return "changed";
  if (!typable(seen)) return "wait";
  if (seen.pid !== undefined && (into.pid === undefined || into.sessionId === undefined)) return "changed";
  if (!sameAgent(into, seen)) return "changed";
  const draft = await draftOf(exec, id);
  if (draft === "") return "changed";
  const missed = await submit(exec, id, into, sleep, draft !== undefined, stateDir);
  if (missed !== undefined) throw missed;
  return "submitted";
}

/** The operator's explicit `--to-shell`: `tern run` types the text and Enter, only into a block whose probe says shell. */
export async function typeIntoShell(exec: Exec, id: string, text: string, stateDir?: string): Promise<boolean> {
  const before = await probe(exec, id, stateDir);
  if (before.status !== "shell" || !before.shellInFront || before.pid !== undefined) return false;
  await ternCall(exec, ["run", id, "--", text], { redact: text });
  return true;
}

export async function keys(exec: Exec, id: string, names: readonly Key[]): Promise<void> {
  if (names.length > 0) await ternCall(exec, ["send", id, "keys", ...names.map((k) => KEY_NAMES[k])]);
}

/**
 * The last `lines` rows of the block (screen plus scrollback), trailing blank rows dropped. `unwrapped` joins rows as
 * wide as the block (hc's rule: Tern says nothing about soft wraps either).
 */
export async function read(exec: Exec, id: string, lines: number, unwrapped = false): Promise<string> {
  const result = await ternCall(exec, ["capture", id, "--scrollback"]);
  const rows = (typeof result["text"] === "string" ? result["text"] : "").split("\n");
  while (rows.length > 0 && rows.at(-1)?.trim() === "") rows.pop();
  const text = rows.slice(-Math.max(lines, 1)).join("\n");
  if (!unwrapped) return text;
  const cols = (await layout(exec)).blocks.find((b) => b.id === id)?.cols;
  return cols !== undefined && cols > 0 ? joinWrapped(text, cols) : text;
}
