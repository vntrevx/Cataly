import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSourceBundle } from "../../../../src/release/source-bundle.ts";

export function doctorCommand(directory: string): readonly string[] {
  const executable = join(directory, "omp");
  const version = readSourceBundle(resolve(import.meta.dir, "../../../.."), true).lock.nativeVersion;
  writeFileSync(
    executable,
    `#!${process.execPath}
if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});
else if (process.argv[2] === "--help") console.log("--config --extension --no-extensions --model");
else process.exit(1);
`,
    { mode: 0o700 },
  );
  return [executable];
}
