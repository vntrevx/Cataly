import { classifyOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "../../../../src/runtime/omp-options.ts";
import { OMP_EXECUTABLE, sourceOmpArgv } from "../../../../src/runtime/omp.ts";

const NOT_FRESH =
  /^(?:--resume|--continue|--session|--restore|--fork|--from-claude|--from-codex|--profile|--alias|-r|-c)(?:=|$)/;
const INTERPRETER_FLAGS = new Set(["--no-env-file", "--no-warnings", "--enable-source-maps"]);

export function isPolicyLaneCommand(argv: readonly string[]): boolean {
  const classified = classifyOmpArgv(argv);
  if (classified.kind !== "omp") return false;
  const command = classified.command;
  const interpreter = command[0]?.split("/").at(-1);
  let at = 1;
  if (sourceOmpArgv(command)) at = command[3] === "--preload" ? 6 : 4;
  else if (interpreter === "bun" || interpreter === "node") {
    while (INTERPRETER_FLAGS.has(command[at] ?? "")) at++;
    if (interpreter === "bun" && command[at] === "run") at++;
    while (INTERPRETER_FLAGS.has(command[at] ?? "")) at++;
    // Interpreter eval, define and arbitrary preload values are not executable entries.
    if (!OMP_EXECUTABLE.test(command[at] ?? "")) return false;
    at++;
  }
  let roles = 0;
  for (; at < command.length; at++) {
    const arg = command[at]!;
    if (arg === "--") break;
    if (NOT_FRESH.test(arg)) return false;
    // Native prompts may appear among options; only -- ends flag parsing.
    if (!arg.startsWith("-")) continue;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flag !== "--dori-role" && NATIVE_VALUE_FLAGS[flag] !== true) continue;
    const value = equals < 0 ? command[++at] : arg.slice(equals + 1);
    // A bare flag-shaped value is ambiguous when an extension shadows a native string flag.
    if (!value || (equals < 0 && value.startsWith("-"))) return false;
    if (flag === "--dori-role") {
      if (value !== "lane") return false;
      roles++;
    }
  }
  return roles === 1;
}
