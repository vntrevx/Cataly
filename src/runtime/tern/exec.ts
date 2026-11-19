// One `tern` call: `--json` goes right before the `--` separator (or last), so a text or command after `--` is
// taken verbatim whatever it holds. Tern prints its failures as plain text (`tern <verb>: <reason>`, exit 1).
import type { Exec, ExecResult } from "../exec.ts";
import { ToolError } from "../exec.ts";

/** A `tern` call that exited non-zero. `reason` is Tern's own message; neither it nor `argv` carries a redacted value. */
export class TernError extends ToolError {
  override readonly name = "TernError";
  readonly reason: string;

  constructor(argv: readonly string[], result: ExecResult, redact?: string) {
    super(argv, result, "tern");
    const raw = (result.stderr || result.stdout).trim().replace(/^tern(?: [a-z-]+)?: /, "") || "no output";
    this.reason = redact === undefined || redact === "" ? raw : raw.replaceAll(redact, "<text>");
    this.message = `tern ${argv.join(" ")} failed (${result.code}): ${this.reason}`;
  }

  /** The block, tab or session the call named does not exist (closed, or never there). */
  get missing(): boolean {
    return /\bno (?:block|tab|session) is called\b/.test(this.reason);
  }
}

export const isMissing = (e: unknown): e is TernError => e instanceof TernError && e.missing;

export type TernCallOptions = { readonly redact?: string };

/** `tern <argv...> --json [-- <rest>]`: the parsed JSON object, `{}` for an empty answer. */
export async function ternCall(
  exec: Exec,
  argv: readonly string[],
  options: TernCallOptions = {},
): Promise<Record<string, unknown>> {
  const cut = argv.indexOf("--");
  const full = cut === -1 ? [...argv, "--json"] : [...argv.slice(0, cut), "--json", ...argv.slice(cut)];
  const result = await exec("tern", full);
  if (result.code !== 0) {
    const shown = options.redact === undefined ? full : full.map((a) => (a === options.redact ? "<text>" : a));
    throw new TernError(shown, result, options.redact);
  }
  const text = result.stdout.trim();
  if (text === "") return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
