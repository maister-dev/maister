CREATE TABLE "run_context_transcript_revisions" (
	"run_id" text NOT NULL,
	"node_attempt_id" text,
	"revision" bigint NOT NULL,
	"last_run_sequence" bigint NOT NULL,
	CONSTRAINT "run_context_transcript_revisions_scope_uq" UNIQUE NULLS NOT DISTINCT("run_id","node_attempt_id"),
	CONSTRAINT "run_context_transcript_revisions_clock_check" CHECK ("run_context_transcript_revisions"."revision" > 0 AND "run_context_transcript_revisions"."last_run_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD COLUMN "coverage_incomplete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD COLUMN "active_compactions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD COLUMN "completed_compactions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD COLUMN "compaction_run_sequence" bigint;--> statement-breakpoint
ALTER TABLE "run_session_incarnations" ADD COLUMN "context_node_attempt_id" text;--> statement-breakpoint
ALTER TABLE "run_context_transcript_revisions" ADD CONSTRAINT "run_context_transcript_revisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_transcript_revisions" ADD CONSTRAINT "run_context_transcript_revisions_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_session_incarnations" ADD CONSTRAINT "run_session_incarnations_context_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("context_node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_session_incarnations_context_attempt_idx" ON "run_session_incarnations" USING btree ("run_id","context_node_attempt_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "run_session_incarnations"."context_node_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_session_incarnations_current_context_idx" ON "run_session_incarnations" USING btree ("run_id",("state" IN ('created', 'active', 'checkpointed')) DESC,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD CONSTRAINT "run_context_usage_compaction_counts_check" CHECK ("run_context_usage"."active_compactions" >= 0 AND "run_context_usage"."completed_compactions" >= 0
        AND ("run_context_usage"."compaction_run_sequence" IS NULL OR "run_context_usage"."compaction_run_sequence" >= 0));
--> statement-breakpoint
-- 0358 keyed inline compactions by the JSONB-escaped adapter ID. The
-- projectors run independently, so either row can exist before the other.
-- Use their first canonical event to distinguish escaped inline IDs from
-- literal IDs originally read from referenced content.
DO $$
DECLARE
    escape_marker constant text := chr(57344);
    saved record;
    restored_id text;
    old_hash text;
    new_hash text;
BEGIN
    FOR saved IN
        WITH anchors AS (
            SELECT run_id, first_run_sequence AS sequence
            FROM run_context_compactions
            WHERE strpos(compaction_id, escape_marker || 'E') > 0
            UNION
            SELECT run_id,
                CASE WHEN pg_input_is_valid(first_supervisor_event_id, 'bigint')
                     THEN first_supervisor_event_id::bigint END
            FROM run_messages
            WHERE projection_tool_key LIKE 'compaction:%'
        )
        SELECT e.run_id, e.run_sequence, e.execution_host_id, e.execution_assignment_id,
            e.assignment_epoch, e.host_session_id, id.escaped_id
        FROM anchors a
        JOIN execution_events e ON e.run_id = a.run_id AND e.run_sequence = a.sequence
        CROSS JOIN LATERAL (VALUES (e.payload->'update'->>'compactionId')) id(escaped_id)
        WHERE e.source = 'host' AND e.ingest_disposition = 'accepted'
            AND e.event_type = 'session.update'
            AND e.payload_schema = 'maister.session.update.v1'
            AND e.payload->'update'->>'sessionUpdate' = 'compaction_update'
            AND strpos(id.escaped_id, escape_marker || 'E') > 0
            AND strpos(replace(id.escaped_id, escape_marker || 'E', ''), escape_marker) = 0
        -- Restoring an ID shortens it. The shorter escaped keys must move
        -- first when one of them is the restored value of a longer key.
        ORDER BY length(id.escaped_id)
    LOOP
        restored_id := replace(saved.escaped_id, escape_marker || 'E', escape_marker);
        old_hash := encode(sha256(convert_to(saved.escaped_id, 'UTF8')), 'hex');
        new_hash := encode(sha256(convert_to(restored_id, 'UTF8')), 'hex');

        UPDATE run_context_compactions c
        SET compaction_id = restored_id
        WHERE c.run_id = saved.run_id AND c.first_run_sequence = saved.run_sequence
            AND c.execution_host_id = saved.execution_host_id
            AND c.assignment_id = saved.execution_assignment_id
            AND c.assignment_epoch = saved.assignment_epoch
            AND c.host_session_id = saved.host_session_id
            AND c.compaction_id = saved.escaped_id
            AND NOT EXISTS (
                SELECT 1 FROM run_context_compactions other
                WHERE (other.run_id, other.execution_host_id, other.assignment_id,
                    other.assignment_epoch, other.host_session_id, other.compaction_id)
                    = (c.run_id, c.execution_host_id, c.assignment_id,
                        c.assignment_epoch, c.host_session_id, restored_id)
            );

        UPDATE run_messages m
        SET projection_tool_key = left(m.projection_tool_key, -64) || new_hash
        WHERE m.run_id = saved.run_id
            AND m.first_supervisor_event_id = saved.run_sequence::text
            AND m.projection_tool_key LIKE 'compaction:%'
            AND right(m.projection_tool_key, 64) = old_hash
            AND NOT EXISTS (
                SELECT 1 FROM run_messages other
                WHERE other.run_id = m.run_id
                    AND other.projection_tool_key = left(m.projection_tool_key, -64) || new_hash
            );
    END LOOP;
END $$;
--> statement-breakpoint
-- Seed the materialized counts from the 0358 facts. A marker can exist before
-- any token observation, so keep the original usage cursor untouched.
INSERT INTO "run_context_usage" (
    "run_id", "execution_host_id", "assignment_id", "assignment_epoch",
    "host_session_id", "node_attempt_id", "last_run_sequence",
    "active_compactions", "completed_compactions", "compaction_run_sequence"
)
SELECT
    "run_id", "execution_host_id", "assignment_id", "assignment_epoch",
    "host_session_id", "node_attempt_id", 0,
    count(*) FILTER (WHERE "status" = 'in_progress'),
    count(*) FILTER (WHERE "status" = 'completed'),
    max("last_run_sequence")
FROM "run_context_compactions"
GROUP BY "run_id", "execution_host_id", "assignment_id", "assignment_epoch",
    "host_session_id", GROUPING SETS (("node_attempt_id"), ())
HAVING GROUPING("node_attempt_id") = 1 OR "node_attempt_id" IS NOT NULL
ON CONFLICT (
    "run_id", "execution_host_id", "assignment_id", "assignment_epoch",
    "host_session_id", "node_attempt_id"
) DO UPDATE SET
    "active_compactions" = EXCLUDED."active_compactions",
    "completed_compactions" = EXCLUDED."completed_compactions",
    "compaction_run_sequence" = EXCLUDED."compaction_run_sequence";
--> statement-breakpoint
INSERT INTO "run_context_transcript_revisions" (
    "run_id", "node_attempt_id", "revision", "last_run_sequence"
)
SELECT "run_id", "node_attempt_id", 1, max("supervisor_event_id"::bigint)
FROM "run_messages"
WHERE "projection_tool_key" LIKE 'compaction:%'
  AND "supervisor_event_id" ~ '^(0|[1-9][0-9]{0,18})$'
  AND pg_input_is_valid("supervisor_event_id", 'bigint')
GROUP BY "run_id", GROUPING SETS (("node_attempt_id"), ())
HAVING GROUPING("node_attempt_id") = 1 OR "node_attempt_id" IS NOT NULL;
