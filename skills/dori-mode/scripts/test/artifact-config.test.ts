import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifactRoots } from "../src/artifact-config.ts";
import { ConfigError, expandHome, loadConfig } from "../src/config.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const parse = (value: unknown) => parseArtifactRoots(value, (path) => expandHome(path, state.dir), ConfigError);

test("publication is opt-in and normalizes an explicitly configured prefix", () => {
  expect(parse(undefined)).toEqual([]);
  expect(parse([])).toEqual([]);
  expect(parse([{ path: "~/reports", baseUrl: "https://files.example:8800/reports" }, { path: "~/notes" }])).toEqual([
    { path: join(state.dir, "reports"), baseUrl: "https://files.example:8800/reports/" },
    { path: join(state.dir, "notes") },
  ]);
});
test.each([
  null,
  {},
  "reports",
  [null],
  [{ path: "relative" }],
  [{ path: "/files", publicUrl: "https://files.example/" }],
  [{ path: "/files\n" }],
  [{ path: "/files", baseUrl: 1 }],
  [{ path: "/files", baseUrl: "file:///files" }],
  [{ path: "/files", baseUrl: "https://user:password@example.test/" }],
  [{ path: "/files", baseUrl: "https://example.test/?key=value" }],
  [{ path: "/files", baseUrl: "https://example.test/?" }],
  [{ path: "/files", baseUrl: "https://example.test/#" }],
  [{ path: "/files", baseUrl: "https://exam\nple.test/" }],
  [{ path: "/files" }, { path: "/files/" }],
])("rejects malformed or ambiguous mapping: %j", (value) => {
  expect(() => parse(value)).toThrow(ConfigError);
});
test("loadConfig validates and expands artifact roots rather than trusting raw JSON", async () => {
  const path = join(state.dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ artifactRoots: [{ path: "~/reports", baseUrl: "http://files.example/reports/" }] }),
  );
  expect((await loadConfig(path, state.dir)).artifactRoots).toEqual([
    { path: join(state.dir, "reports"), baseUrl: "http://files.example/reports/" },
  ]);
  writeFileSync(path, JSON.stringify({ artifactRoots: "invalid" }));
  await expect(loadConfig(path, state.dir)).rejects.toThrow("artifactRoots");
});
