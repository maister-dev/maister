ALTER TABLE "execution_runtime_objects" DROP CONSTRAINT "execution_runtime_objects_metadata_state_check";--> statement-breakpoint
ALTER TABLE "execution_runtime_objects" ADD COLUMN "declared_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "execution_runtime_objects" ADD COLUMN "declared_sha256" text;--> statement-breakpoint
-- Recover only the first exact reserve intent. A compacted or absent request
-- cannot prove a declaration; sealed metadata is never substituted for it.
-- Equal earliest timestamps do not prove which random command ID came first.
WITH original_intents AS (
  SELECT DISTINCT ON (run_id, execution_host_id, execution_assignment_id, assignment_epoch, target_session_id)
    run_id, execution_host_id, execution_assignment_id, assignment_epoch,
    target_session_id, payload,
    count(*) OVER (
      PARTITION BY run_id, execution_host_id, execution_assignment_id,
        assignment_epoch, target_session_id, created_at
    ) AS contemporaries
  FROM execution_commands
  WHERE kind = 'runtime_object.reserve'
  ORDER BY run_id, execution_host_id, execution_assignment_id, assignment_epoch,
    target_session_id, created_at, id
)
UPDATE execution_runtime_objects AS object
SET declared_size_bytes = (intent.payload->>'sizeBytes')::bigint,
    declared_sha256 = intent.payload->>'sha256'
FROM original_intents AS intent
WHERE object.id = intent.target_session_id
  AND intent.contemporaries = 1
  AND object.run_id = intent.run_id
  AND object.execution_host_id = intent.execution_host_id
  AND object.execution_assignment_id = intent.execution_assignment_id
  AND object.assignment_epoch = intent.assignment_epoch
  AND intent.payload->>'objectId' = object.id
  AND intent.payload->>'generation' = object.generation::text
  AND intent.payload->>'kind' = object.kind
  AND intent.payload->>'logicalName' = object.logical_name
  AND intent.payload->>'mimeType' = object.mime_type
  AND intent.payload->>'retentionClass' = object.retention_class
  AND (
    (object.expires_at IS NULL AND (
      intent.payload->'expiresAt' IS NULL OR intent.payload->'expiresAt' = 'null'::jsonb
    )) OR (
      jsonb_typeof(intent.payload->'expiresAt') = 'string'
      AND CASE
        WHEN pg_input_is_valid(intent.payload->>'expiresAt', 'timestamptz')
        THEN (intent.payload->>'expiresAt')::timestamptz = object.expires_at
        ELSE false
      END
    )
  )
  AND jsonb_typeof(intent.payload->'sizeBytes') = 'number'
  AND intent.payload->>'sizeBytes' ~ '^(0|[1-9][0-9]{0,15})$'
  AND intent.payload->>'sha256' ~ '^[a-f0-9]{64}$';--> statement-breakpoint
ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_declaration_check" CHECK (("execution_runtime_objects"."declared_size_bytes" IS NULL AND "execution_runtime_objects"."declared_sha256" IS NULL) OR ("execution_runtime_objects"."declared_size_bytes" IS NOT NULL AND "execution_runtime_objects"."declared_size_bytes" >= 0 AND "execution_runtime_objects"."declared_sha256" IS NOT NULL AND "execution_runtime_objects"."declared_sha256" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_metadata_state_check" CHECK (("execution_runtime_objects"."state" = 'pending' AND "execution_runtime_objects"."size_bytes" IS NULL AND "execution_runtime_objects"."sha256" IS NULL AND "execution_runtime_objects"."sealed_at" IS NULL) OR ("execution_runtime_objects"."state" IN ('pending', 'available', 'deleting', 'missing', 'deleted', 'expired', 'corrupt') AND "execution_runtime_objects"."size_bytes" IS NOT NULL AND "execution_runtime_objects"."sha256" IS NOT NULL AND "execution_runtime_objects"."sha256" ~ '^[a-f0-9]{64}$' AND "execution_runtime_objects"."sealed_at" IS NOT NULL));
