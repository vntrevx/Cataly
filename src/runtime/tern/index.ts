import type { Exec } from "../exec.ts";
import { spawnExec } from "../exec.ts";
import type { Sleep } from "../herdr/deliver.ts";
import type {
  AgentIdentity,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { deliver, keys, read, submitTyped, typeIntoShell } from "./deliver.ts";
import { probe } from "./probe.ts";
import { close, create, list, ownSession, selfRef, start } from "./sessions.ts";

type Env = Readonly<Record<string, string | undefined>>;
export type TernRuntimeOptions = { readonly env?: Env; readonly sleep?: Sleep; readonly stateDir?: string };

/** Tern behind the session runtime interface: a session is a block, its group the Tern session, its container the tab. */
export class TernRuntime implements SessionRuntime {
  readonly kind = "tern";
  private readonly env: Env;
  private readonly sleep: Sleep;
  private readonly stateDir: string | undefined;

  constructor(
    private readonly exec: Exec = spawnExec,
    options: TernRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.stateDir = options.stateDir;
  }

  self(): SessionRef | undefined {
    return selfRef(this.env);
  }

  /** The caller's own Tern session, else one named `label`; nothing is created until a block opens in it. */
  createGroup(label: string, _cwd: string): Promise<string> {
    return ownSession(this.exec, this.env, label);
  }

  create(spec: CreateSpec): Promise<SessionRef> {
    return create(this.exec, spec, this.env);
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.exec, ref.id, command);
  }

  /** The live terminal blocks of one Tern session (`group`, a name or an id), or of every session of the window. */
  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.exec, filter?.group);
  }

  probe(ref: SessionRef): Promise<Probe> {
    return probe(this.exec, ref.id, this.stateDir);
  }

  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string> {
    return read(this.exec, ref.id, lines, opts?.unwrapped ?? false);
  }

  /** Tern itself reports no blocked state, so `force` changes nothing: an OMP approval always holds delivery. */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.exec, ref.id, text, this.sleep, opts, this.stateDir);
  }

  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult> {
    return submitTyped(this.exec, ref.id, into, this.sleep, this.stateDir);
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.exec, ref.id, text, this.stateDir);
  }

  keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    return keys(this.exec, ref.id, names);
  }

  /** `tern close` on the block; its tab goes with its last block, so every scope closes the same thing. */
  close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    return close(this.exec, ref.id);
  }
}
