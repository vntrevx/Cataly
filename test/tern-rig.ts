import { TernRuntime, type TernRuntimeOptions } from "../src/runtime/tern/index.ts";
import type { CreateSpec, SessionRef } from "../src/runtime/types.ts";
import { type FakeBlock, FakeTern } from "./fake-tern.ts";

// The tern adapter over the FakeTern recorder, shared by the runtime-tern*.test.ts files.
export const B1: SessionRef = { runtime: "tern", id: "5001" };

export function rig(initial: Record<string, FakeBlock> = {}, options: TernRuntimeOptions = {}) {
  const fake = new FakeTern(initial);
  const sleeps: number[] = [];
  const rt = new TernRuntime(fake.exec, {
    env: { SHELL: "/bin/zsh" },
    sleep: async (ms) => void sleeps.push(ms),
    ...options,
  });
  return { fake, rt, sleeps };
}

export const lane: CreateSpec = {
  name: "Lane K",
  cwd: "/w",
  env: { A: "1", B: "it's a b" },
  role: "lane",
  container: "tab",
};

/** The `tern` calls of one verb (the argv after `tern`, `--json` left out). */
export const callsOf = (fake: FakeTern, verb: string): string[][] => fake.calls.filter((c) => c[0] === verb);
