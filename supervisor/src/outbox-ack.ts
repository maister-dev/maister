import type { DatabaseSync } from "node:sqlite";
import type { EventPartition } from "./outbox-budget";

// ACK changes only the stream, three counters and one compact range. Rewriting
// the payload rows would copy an entire retained backlog into the WAL at once.
export const OUTBOX_ACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_event_ack_ranges (
  stream_id TEXT NOT NULL REFERENCES runtime_event_streams (stream_id),
  first_sort_key TEXT NOT NULL,
  through_sort_key TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, through_sort_key),
  CHECK (first_sort_key <= through_sort_key)
);
DROP TRIGGER IF EXISTS runtime_event_budget_ack;
DROP TRIGGER IF EXISTS runtime_event_budget_delete;
CREATE TRIGGER IF NOT EXISTS runtime_event_budget_delete_v8 AFTER DELETE ON runtime_event_outbox BEGIN
  UPDATE runtime_event_budget SET
    retained_count = retained_count - 1,
    retained_bytes = retained_bytes - OLD.encoded_bytes,
    unacknowledged_count = unacknowledged_count - CASE WHEN OLD.sequence_sort_key >
      COALESCE((SELECT acknowledged_sort_key FROM runtime_event_streams WHERE stream_id = OLD.stream_id), '') THEN 1 ELSE 0 END,
    unacknowledged_bytes = unacknowledged_bytes - CASE WHEN OLD.sequence_sort_key >
      COALESCE((SELECT acknowledged_sort_key FROM runtime_event_streams WHERE stream_id = OLD.stream_id), '') THEN OLD.encoded_bytes ELSE 0 END
  WHERE partition = OLD.budget_partition;
END;
`;

// Queries use the local alias e. Existing row-level timestamps remain readable
// without a data rewrite; new rows derive their time from an immutable range.
export const RUNTIME_EVENT_ACK_TIMESTAMP_SQL = `COALESCE(e.acknowledged_at,
  (SELECT a.acknowledged_at FROM runtime_event_ack_ranges a
   WHERE a.stream_id = e.stream_id AND a.through_sort_key >= e.sequence_sort_key
     AND a.first_sort_key <= e.sequence_sort_key
   ORDER BY a.through_sort_key ASC LIMIT 1))`;

/** The caller owns the same transaction as contiguous validation and watermark. */
export function recordRuntimeEventAck(
  db: DatabaseSync,
  input: {
    streamId: string;
    firstSortKey: string;
    throughSortKey: string;
    acknowledgedAt: string;
  },
): void {
  const partitions = db
    .prepare(
      `SELECT budget_partition AS partition,
      COUNT(*) AS count, SUM(encoded_bytes) AS bytes FROM runtime_event_outbox
    WHERE stream_id = ? AND sequence_sort_key >= ? AND sequence_sort_key <= ?
    GROUP BY budget_partition`,
    )
    .all(input.streamId, input.firstSortKey, input.throughSortKey) as Array<{
    partition: EventPartition;
    count: number;
    bytes: number;
  }>;

  for (const partition of partitions) {
    db.prepare(
      `UPDATE runtime_event_budget SET unacknowledged_count = unacknowledged_count - ?,
      unacknowledged_bytes = unacknowledged_bytes - ? WHERE partition = ?`,
    ).run(partition.count, partition.bytes, partition.partition);
  }
  db.prepare(
    `INSERT INTO runtime_event_ack_ranges
    (stream_id, first_sort_key, through_sort_key, acknowledged_at) VALUES (?, ?, ?, ?)`,
  ).run(
    input.streamId,
    input.firstSortKey,
    input.throughSortKey,
    input.acknowledgedAt,
  );
}
