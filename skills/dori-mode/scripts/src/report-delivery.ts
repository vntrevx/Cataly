import { sentReceipts } from "./owes.ts";
import { ReportError } from "./report-events.ts";
import type { Report } from "./reports.ts";
import type { ReportDelivery } from "./request-identity.ts";

/** A caller-declared association, not proof of equal message bodies or human reading. */
export const reportDelivery = (stateDir: string, report: Report, deliveryId?: string): ReportDelivery => {
  if (deliveryId === undefined) return { state: "unverified", reason: "No exact Discord reply receipt is linked" };
  const requestId = report.provenance?.requestId;
  if (!requestId?.startsWith("discord:"))
    throw new ReportError("relayed: exact delivery linking requires a recorded Discord request");
  const matches = sentReceipts(stateDir).filter((receipt) => receipt.deliveryId === deliveryId);
  const receipt = matches.length === 1 ? matches[0] : undefined;
  if (!receipt || `discord:${receipt.requestId}` !== requestId || receipt.at < Date.parse(report.at))
    throw new ReportError(
      "relayed: delivery is missing, ambiguous, older than the report, or belongs to another request",
    );
  return {
    state: "linked",
    deliveryId: receipt.deliveryId,
    requestId,
    channel: receipt.channel,
    remoteIds: receipt.remoteIds,
    at: receipt.at,
  };
};
