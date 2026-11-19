import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DoriApi, DoriContext } from "./index.ts";
import type { DoriRole } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { checkPolicyCommand } from "../skills/dori-mode/scripts/src/lane-policy-actions.ts";
import { PolicyError } from "../skills/dori-mode/scripts/src/lane-policy.ts";

const ENTRY = "omp-dori:lane-policy";
type Binding = string | { readonly error: string };
type Branch = ReturnType<DoriContext["sessionManager"]["getBranch"]>;
type Inherited = { readonly role: DoriRole | undefined; readonly binding: Binding | undefined };
const agentPolicies = new Map<string, Inherited>();
const recordedBinding = (branch: Branch): Binding | undefined => {
  const entry = branch.filter((entry) => entry.type === "custom" && entry.customType === ENTRY).at(-1);
  return entry === undefined
    ? undefined
    : typeof entry.data === "string"
      ? entry.data
      : { error: "invalid recorded lane policy binding" };
};

export const lanePolicyHook = (
  pi: DoriApi & { pi?: Pick<ExtensionAPI["pi"], "loadSessionFile" | "SessionEntryIndex"> },
  recordedRole: (branch: Branch) => DoriRole | undefined,
) => {
  let binding: Binding | undefined;
  pi.on("tool_call", (event) => {
    const call = event as { toolName?: unknown; input?: unknown } | null;
    if (binding === undefined || typeof call !== "object" || call === null || call.toolName !== "bash") return;
    try {
      if (typeof binding !== "string") throw new PolicyError(binding.error);
      const input = call.input as { command?: unknown } | null;
      if (typeof input !== "object" || input === null || typeof input.command !== "string")
        throw new PolicyError("configured lane policy received a bash call without a command string");
      const reason = checkPolicyCommand(binding, input.command, Date.now());
      return reason ? { block: true, reason } : undefined;
    } catch (error) {
      // Native OMP may catch handler exceptions. Returning block is required to stop approval and execution.
      const reason = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `LANE_POLICY_ERROR: ${reason}. Report this blocker; no command ran.` };
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    agentPolicies.delete(ctx.agent.id);
    binding = undefined;
  });
  pi.on("before_subagent_spawn", (_event, ctx) => {
    if (binding !== undefined && !ctx.sessionManager.getSessionFile())
      return {
        block: true,
        reason: "Lane policy inheritance requires a persisted native parent session; no subagent started.",
      };
  });
  return {
    inherit: async (ctx: DoriContext): Promise<Inherited> => {
      try {
        const own = ctx.sessionManager.getBranch();
        const saved = { role: recordedRole(own), binding: recordedBinding(own) };
        if (saved.role !== undefined || saved.binding !== undefined) return saved;
        const parent = ctx.agent.parentId;
        if (parent !== undefined && agentPolicies.has(parent)) return agentPolicies.get(parent)!;
        // Native worker realms re-import extensions. Their session header names the spawning transcript.
        const file = ctx.sessionManager.getHeader()?.parentSession;
        if (!file) return { role: undefined, binding: undefined };
        if (!pi.pi) throw new PolicyError("native session reader is unavailable");
        const loaded = await pi.pi.loadSessionFile(file, undefined, { throwIfMissing: true });
        if (loaded.invalidHeader || loaded.entries[0]?.type !== "session")
          throw new PolicyError("invalid parent session transcript");
        const index = new pi.pi.SessionEntryIndex();
        index.rebuild(loaded.entries.filter((entry) => entry.type !== "session"));
        const branch = index.pathTo();
        const inherited = { role: recordedRole(branch), binding: recordedBinding(branch) };
        if (loaded.malformedRecords && inherited.binding !== undefined)
          throw new PolicyError("invalid parent policy transcript");
        return inherited;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { role: undefined, binding: { error: `cannot inherit parent session: ${message}` } };
      }
    },
    sync: (
      role: DoriRole | undefined,
      ctx: DoriContext,
      eventName: string,
      event: unknown,
      flaggedRole: boolean,
      inherited: Inherited | undefined,
    ): void => {
      const recorded = recordedBinding(ctx.sessionManager.getBranch());
      if (ctx.agent.kind === "sub") binding = inherited?.binding;
      else if (role !== "lane") binding = undefined;
      else {
        const carried =
          eventName === "session_switch" &&
          typeof event === "object" &&
          event !== null &&
          "reason" in event &&
          event.reason === "new";
        if (recorded !== undefined) binding = recorded;
        else if (!carried)
          binding =
            eventName === "session_start" && flaggedRole ? process.env["DORI_LANE_POLICY"] || undefined : undefined;
      }
      if (recorded === undefined && binding !== undefined)
        pi.appendEntry(ENTRY, typeof binding === "string" ? binding : null);
      agentPolicies.set(ctx.agent.id, { role, binding });
    },
  };
};
