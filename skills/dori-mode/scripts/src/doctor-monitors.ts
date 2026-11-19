import { readRuntimeHealth } from "../../../../src/update/deployment-monitor-receipts.ts";
import { processIdentity, underProcess } from "../../../../src/update/deployment-process.ts";
import type { Manifest } from "./boot-monitors.ts";
import type { DoctorFinding } from "./doctor.ts";
import type { PaneState } from "./lane-state.ts";
import { monitorPresetFor } from "./monitor-presets.ts";

export const monitorFilterFindings = (manifests: readonly Manifest[], liveSession?: string): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "omp") continue;
    const severity = manifest.data.sessionId === liveSession ? "WARN" : "INFO";
    for (const monitor of manifest.data.monitors) {
      const preset = monitorPresetFor(monitor.argv ?? []);
      if (!preset) continue;
      const label = `${JSON.stringify(monitor.name)}${severity === "INFO" ? ` (recorded session ${JSON.stringify(manifest.data.sessionId)}; liveness unverified)` : ""}`;
      try {
        const filter = new RegExp(monitor.filter ?? ".");
        const missing = preset.events.filter((event) => !filter.test(`${event} diagnostic detail`));
        if (missing.length)
          findings.push({
            check: "monitor-filter",
            severity,
            detail:
              label +
              " misses probes: " +
              missing.join(" ") +
              "; inspect dori monitor-presets " +
              preset.name +
              " in the owner session",
          });
      } catch {
        findings.push({
          check: "monitor-filter",
          severity,
          detail: `${label} has an invalid regular expression`,
        });
      }
    }
  }
  return findings;
};

/** Desired intent is not liveness; only a fresh receipt bound to the trusted lead can attest a child. */
export const monitorRuntimeFindings = (
  stateDir: string,
  manifests: readonly Manifest[],
  lead: PaneState | null,
  now: number,
): DoctorFinding[] => {
  const wanted = manifests.filter((manifest) => manifest.kind === "omp" && manifest.data.monitors.length);
  const findings: DoctorFinding[] = [];
  for (const manifest of wanted) {
    if (!lead || manifest.data.sessionId !== lead.sessionId) {
      findings.push({
        check: "monitor-runtime",
        severity: "INFO",
        detail:
          JSON.stringify(manifest.data.sessionId) +
          " has " +
          manifest.data.monitors.length +
          " recorded monitors; liveness unverified (not the current trusted lead)",
      });
      continue;
    }
    try {
      const health = readRuntimeHealth({ stateDir, pane: lead.paneId, sessionId: lead.sessionId });
      if (
        !health ||
        health.pid !== lead.pid ||
        health.startedAt !== lead.startedAt ||
        now - Date.parse(health.updatedAt) > 5_000 ||
        Date.parse(health.updatedAt) > now + 1_000
      ) {
        findings.push({
          check: "monitor-runtime",
          severity: "WARN",
          detail: "lead monitor health is absent, stale or belongs to another process; liveness unverified",
        });
        continue;
      }
      for (const spec of manifest.data.monitors) {
        try {
          const running = health.monitors.find((entry) => entry && entry.name === spec.name);
          const identity =
            running && Number.isSafeInteger(running.pid) && running.pid > 0 ? processIdentity(running.pid) : undefined;
          const live =
            running &&
            identity &&
            running.pid !== lead.pid &&
            identity.startTicks === running.startTicks &&
            underProcess(running.pid, lead.pid);
          const matches =
            live &&
            JSON.stringify(running.argv) === JSON.stringify(spec.argv) &&
            running.cwd === spec.cwd &&
            new RegExp(running.filter).source === new RegExp(spec.filter ?? ".").source;
          findings.push({
            check: "monitor-runtime",
            severity: matches ? "OK" : "WARN",
            detail:
              JSON.stringify(spec.name) +
              (matches
                ? " live with recorded spec"
                : " recorded but no matching live child; inspect in the owner session (no automatic restart)"),
          });
        } catch {
          findings.push({
            check: "monitor-runtime",
            severity: "WARN",
            detail: `${JSON.stringify(spec.name)} has an invalid or unreadable process receipt; liveness unverified`,
          });
        }
      }
    } catch {
      findings.push({
        check: "monitor-runtime",
        severity: "WARN",
        detail: "lead monitor health is unreadable or invalid; liveness unverified",
      });
    }
  }
  return findings;
};
