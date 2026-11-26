-- Schema v10 (additive): authenticated request admission outlives relay handoff receipts.
ALTER TABLE requests ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0 CHECK (admitted IN (0, 1));

-- An older row counts only when its exact original lead handoff still proves admission.
UPDATE requests SET admitted = 1 WHERE source IN (
    SELECT request_id FROM handoffs
    WHERE relay = 'discord' AND target = 'lead' AND state IN ('handed', 'delivered')
      AND request_id = 'discord:' || room || ':' || message
);
