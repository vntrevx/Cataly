import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { MessengerError } from "./http.ts";

export type HeadAttempt = {
  identity: string;
  fingerprint: string;
  headFile: string;
  headPid: number;
  source: DiscordInbound;
};
export type HeadAdmission = Omit<HeadAttempt, "source"> & {
  source: string;
  outcome: "accepted" | "rejected" | "unresolved" | "abandoned";
  receipt: string | null;
  reason: string | null;
  attemptedAt: string;
  decidedAt: string | null;
};
export type HeadAdmissionStore = {
  unresolved(): HeadAdmission | null;
  uncommittedReceipt(): HeadAdmission | null;
  assertClear(): void;
  admission(identity: string, fingerprint: string): HeadAdmission | null;
  attempt(input: HeadAttempt): void;
  receipt(identity: string, outcome: "accepted" | "rejected", receipt: string): void;
  abandon(identity: string, reason: string): HeadAdmission;
  pruneReceipts(channel: string, cursor: string): void;
};
export const headUnresolved = () =>
  new MessengerError(
    "HEAD_ADMISSION_UNRESOLVED: Discord head admission is unresolved; the cursor, source and FIFO are retained. " +
      "Inspect the original native receipt; never replay an attempted input. Stop the original head before explicit abandonment.",
    0,
    "HEAD_ADMISSION_UNRESOLVED",
  );

/** The same exclusive SQLite owner protects raw FIFO, source attempts and operator decisions. */
export const headAdmissionState = (db: Database, storage: <T>(job: () => T) => T): HeadAdmissionStore => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS admissions (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, " +
      "head_file TEXT NOT NULL, head_pid INTEGER NOT NULL CHECK(head_pid > 0), source TEXT NOT NULL, " +
      "outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','unresolved','abandoned')), receipt TEXT, reason TEXT, " +
      "attempted_at TEXT NOT NULL, decided_at TEXT, checkpointed INTEGER NOT NULL DEFAULT 0 CHECK(checkpointed IN (0,1)))",
  );
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS unresolved_admission ON admissions ((1)) WHERE outcome = 'unresolved'");
  db.exec("CREATE INDEX IF NOT EXISTS uncommitted_admission ON admissions (checkpointed) WHERE checkpointed = 0");
  const columns =
    "identity, fingerprint, head_file AS headFile, head_pid AS headPid, source, outcome, receipt, reason, " +
    "attempted_at AS attemptedAt, decided_at AS decidedAt";
  const find = db.query<HeadAdmission, [string]>(`SELECT ${columns} FROM admissions WHERE identity = ?`);
  const unknown = db.query<HeadAdmission, []>(`SELECT ${columns} FROM admissions WHERE outcome = 'unresolved'`);
  const uncommitted = db.query<HeadAdmission, []>(
    `SELECT ${columns} FROM admissions WHERE checkpointed = 0 AND outcome <> 'unresolved' ORDER BY rowid LIMIT 1`,
  );
  const start = db.query(
    "INSERT INTO admissions " +
      "(identity, fingerprint, head_file, head_pid, source, outcome, attempted_at) VALUES (?, ?, ?, ?, ?, 'unresolved', ?)",
  );
  const finish = db.query(
    "UPDATE admissions SET outcome = ?, receipt = ?, reason = ?, decided_at = ? WHERE identity = ?",
  );
  const committed =
    "json_extract(source, '$.channel') = ? AND (length(json_extract(source, '$.message')) < length(?) " +
    "OR (length(json_extract(source, '$.message')) = length(?) AND json_extract(source, '$.message') <= ?))";
  const native = "outcome IN ('accepted','rejected')";
  const unqueued =
    "NOT EXISTS (SELECT 1 FROM pending WHERE kind = 'message' " +
    "AND json_extract(payload, '$.channel_id') = json_extract(admissions.source, '$.channel') " +
    "AND length(json_extract(payload, '$.id')) = length(json_extract(admissions.source, '$.message')) " +
    "AND json_extract(payload, '$.id') = json_extract(admissions.source, '$.message'))";
  db.exec(
    `CREATE INDEX IF NOT EXISTS checkpointed_admission ON admissions (json_extract(source, '$.channel'), json_extract(source, '$.message')) WHERE checkpointed = 1 AND ${native}`,
  );
  // Retire with the exact raw ACK, in its transaction, never in the cursor-to-ACK crash window.
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS retire_head_receipt AFTER DELETE ON pending WHEN OLD.kind = 'message' BEGIN DELETE FROM admissions WHERE checkpointed = 1 AND ${native} AND json_extract(source, '$.channel') = json_extract(OLD.payload, '$.channel_id') AND json_extract(source, '$.message') = json_extract(OLD.payload, '$.id') AND ${unqueued}; END`,
  );
  const prune = db.query(
    `DELETE FROM admissions WHERE checkpointed = 1 AND ${native} AND ${committed} AND ${unqueued}`,
  );
  const checkpoint = db.query(
    `UPDATE admissions SET checkpointed = 1 WHERE checkpointed = 0 AND outcome <> 'unresolved' AND ${committed}`,
  );
  const assertClear = () => {
    if (unknown.get()) throw headUnresolved();
  };
  return {
    unresolved: () => storage(() => unknown.get()),
    uncommittedReceipt: () => storage(() => uncommitted.get()),
    assertClear: () => storage(assertClear),
    admission: (identity: string, fingerprint: string) =>
      storage(() => {
        const previous = find.get(identity);
        if (previous && previous.fingerprint !== fingerprint)
          throw new MessengerError("Discord head admission identity conflict; original record retained", 0);
        return previous;
      }),
    attempt: (input: HeadAttempt) =>
      storage(() => {
        if (find.get(input.identity))
          throw new MessengerError(
            "Discord head admission already attempted; reconcile the original receipt before replay",
            0,
          );
        assertClear();
        start.run(
          input.identity,
          input.fingerprint,
          input.headFile,
          input.headPid,
          JSON.stringify(input.source),
          new Date().toISOString(),
        );
      }),
    receipt: (identity: string, outcome: "accepted" | "rejected", receipt: string) =>
      storage(() => {
        const previous = find.get(identity);
        if (!previous) throw new MessengerError("Discord head receipt has no original attempt", 0);
        if (previous.outcome !== "unresolved") {
          if (previous.outcome !== outcome || previous.receipt !== receipt)
            throw new MessengerError("Discord head receipt conflict; original receipt retained", 0);
          return;
        }
        finish.run(outcome, receipt, null, new Date().toISOString(), identity);
      }),
    abandon: (identity: string, reason: string) =>
      storage(() => {
        if (!reason.trim()) throw new MessengerError("An explicit operator abandonment reason is required", 0);
        const previous = find.get(identity);
        if (!previous) throw new MessengerError("Discord head admission has no original attempt", 0);
        if (previous.outcome === "abandoned") {
          if (previous.reason !== reason.trim())
            throw new MessengerError("Discord head abandonment reason conflicts with the original decision", 0);
          return previous;
        }
        if (previous.outcome !== "unresolved")
          throw new MessengerError("A settled native receipt cannot be abandoned", 0);
        // Signal zero only observes the original head. EPERM and an occupied/reused PID both fail closed.
        let gone = false;
        try {
          process.kill(previous.headPid, 0);
        } catch (error) {
          gone = error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
        }
        if (!gone)
          throw new MessengerError("Original head is alive or cannot be proven stopped; abandonment refused", 0);
        finish.run("abandoned", `operator-abandon:${randomUUID()}`, reason.trim(), new Date().toISOString(), identity);
        return find.get(identity)!;
      }),
    // Native receipts require both a durable cursor and no pending copy; operator audit rows never retire.
    pruneReceipts: (channel: string, cursor: string) =>
      storage(() => {
        checkpoint.run(channel, cursor, cursor, cursor);
        prune.run(channel, cursor, cursor, cursor);
      }),
  };
};
