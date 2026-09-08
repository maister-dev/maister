ALTER TABLE "execution_commands" ADD COLUMN "create_intent" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_commands_create_operation_uq" ON "execution_commands" USING btree ("run_id","execution_assignment_id",("create_intent"->>'operationKey'),("create_intent"->>'generation')) WHERE "execution_commands"."create_intent" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_create_intent_check" CHECK ("execution_commands"."create_intent" IS NULL OR ("execution_commands"."kind" = 'session.create'
        AND jsonb_typeof("execution_commands"."create_intent") = 'object' AND "execution_commands"."create_intent"->'version' = '1'::jsonb
        AND jsonb_typeof("execution_commands"."create_intent"->'owner') = 'object'
        AND "execution_commands"."create_intent"->'owner'->>'variant' IN ('node', 'gate_ai', 'gate_skill')
        AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'nodeAttemptId') = 'string'
        AND ("execution_commands"."create_intent" - ARRAY['version','owner','operationKey','generation','supersedesCommandId','sessionFallback','requestCanonicalJson','requestSha256']) = '{}'::jsonb
        AND jsonb_typeof("execution_commands"."create_intent"->'sessionFallback') = 'boolean'
        AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'node' THEN
          (("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','promptOrdinal']) = '{}'::jsonb
          AND ("execution_commands"."create_intent"->'owner'->>'promptOrdinal') ~ '^(0|[1-9][0-9]*)$'
          AND "execution_commands"."create_intent"->>'operationKey' = 'flow-create:node:' || ("execution_commands"."create_intent"->'owner'->>'nodeAttemptId') || ':' || ("execution_commands"."create_intent"->'owner'->>'promptOrdinal')
        ELSE (("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','gateId','evaluationId']) = '{}'::jsonb
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'gateId') = 'string'
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'evaluationId') = 'string'
          AND "execution_commands"."create_intent"->>'operationKey' = 'flow-create:' || ("execution_commands"."create_intent"->'owner'->>'variant') || ':' || ("execution_commands"."create_intent"->'owner'->>'evaluationId') END
        AND length("execution_commands"."create_intent"->>'operationKey') BETWEEN 1 AND 256
        AND ("execution_commands"."create_intent"->>'generation') ~ '^(0|[1-9][0-9]*)$'
        AND ("execution_commands"."create_intent"->>'generation')::numeric <= 2147483647
        AND (("execution_commands"."create_intent"->'generation' = '0'::jsonb AND "execution_commands"."create_intent"->'supersedesCommandId' = 'null'::jsonb)
          OR ("execution_commands"."create_intent"->>'generation')::numeric > 0 AND jsonb_typeof("execution_commands"."create_intent"->'supersedesCommandId') = 'string')
        AND "execution_commands"."create_intent"->>'requestSha256' = encode(sha256(convert_to("execution_commands"."create_intent"->>'requestCanonicalJson', 'UTF8')), 'hex')
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'command'->>'id' = "execution_commands"."id"
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'command'->>'kind' = "execution_commands"."kind"
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'fence'->>'runId' = "execution_commands"."run_id"
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'fence'->>'assignmentId' = "execution_commands"."execution_assignment_id"
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'fence'->'assignmentEpoch' = to_jsonb("execution_commands"."assignment_epoch")
        AND ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'payload'->>'nodeAttemptId' = "execution_commands"."create_intent"->'owner'->>'nodeAttemptId'
      ) IS TRUE);