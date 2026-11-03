ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_create_intent_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_create_intent_check" CHECK ("execution_commands"."create_intent" IS NULL OR ("execution_commands"."kind" = 'session.create'
        AND jsonb_typeof("execution_commands"."create_intent") = 'object' AND "execution_commands"."create_intent"->'version' = '1'::jsonb
        AND jsonb_typeof("execution_commands"."create_intent"->'owner') = 'object'
        AND "execution_commands"."create_intent"->'owner'->>'variant' IN ('node', 'gate_ai', 'gate_skill', 'agent', 'librarian', 'consensus_verifier', 'consensus_synthesis', 'scratch', 'package_scratch', 'gate_chat', 'sync_resolver', 'flow_resume', 'scratch_resume')
        AND ("execution_commands"."create_intent" - ARRAY['version','owner','operationKey','generation','supersedesCommandId','sessionFallback','requestCanonicalJson','requestSha256','continuation']) = '{}'::jsonb
        AND jsonb_typeof("execution_commands"."create_intent"->'sessionFallback') = 'boolean'
        AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' IN ('consensus_verifier', 'consensus_synthesis', 'scratch', 'package_scratch', 'gate_chat', 'sync_resolver', 'flow_resume', 'scratch_resume') THEN
          ((("execution_commands"."create_intent"->'owner')->>'variant' = 'consensus_verifier' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','nodeAttemptId','round','verifierId','targetId','verdictId']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','round','verifierId','targetId','verdictId']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'nodeAttemptId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'nodeAttemptId') BETWEEN 1 AND 128 AND CASE WHEN jsonb_typeof(("execution_commands"."create_intent"->'owner')->'round') = 'number' THEN (("execution_commands"."create_intent"->'owner')->>'round')::numeric BETWEEN 0 AND 9007199254740991 AND (("execution_commands"."create_intent"->'owner')->>'round') ~ '^[0-9]+$' ELSE false END AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'verifierId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'verifierId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'targetId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'targetId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'verdictId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'verdictId') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'consensus-create:verifier:' || (("execution_commands"."create_intent"->'owner')->>'verdictId')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'consensus_synthesis' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','nodeAttemptId','round','synthesisId']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','round','synthesisId']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'nodeAttemptId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'nodeAttemptId') BETWEEN 1 AND 128 AND CASE WHEN jsonb_typeof(("execution_commands"."create_intent"->'owner')->'round') = 'number' THEN (("execution_commands"."create_intent"->'owner')->>'round')::numeric BETWEEN 0 AND 9007199254740991 AND (("execution_commands"."create_intent"->'owner')->>'round') ~ '^[0-9]+$' ELSE false END AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'synthesisId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'synthesisId') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'consensus-create:synthesis:' || (("execution_commands"."create_intent"->'owner')->>'synthesisId')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'scratch' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','scratchRunId','turnId','promptOrdinal']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','scratchRunId','turnId','promptOrdinal']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'scratchRunId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'scratchRunId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'turnId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'turnId') BETWEEN 1 AND 128 AND CASE WHEN jsonb_typeof(("execution_commands"."create_intent"->'owner')->'promptOrdinal') = 'number' THEN (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')::numeric BETWEEN 0 AND 9007199254740991 AND (("execution_commands"."create_intent"->'owner')->>'promptOrdinal') ~ '^[0-9]+$' ELSE false END AND "execution_commands"."create_intent"->>'operationKey' = 'scratch-create:' || (("execution_commands"."create_intent"->'owner')->>'turnId') || ':' || (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'package_scratch' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','scratchRunId','turnId','promptOrdinal','localPackageId','postprocessActionId','lockGeneration']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','scratchRunId','turnId','promptOrdinal','localPackageId','postprocessActionId','lockGeneration']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'scratchRunId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'scratchRunId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'turnId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'turnId') BETWEEN 1 AND 128 AND CASE WHEN jsonb_typeof(("execution_commands"."create_intent"->'owner')->'promptOrdinal') = 'number' THEN (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')::numeric BETWEEN 0 AND 9007199254740991 AND (("execution_commands"."create_intent"->'owner')->>'promptOrdinal') ~ '^[0-9]+$' ELSE false END AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'localPackageId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'localPackageId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'postprocessActionId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'postprocessActionId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'lockGeneration') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'lockGeneration') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'package_scratch-create:' || (("execution_commands"."create_intent"->'owner')->>'turnId') || ':' || (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'gate_chat' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','hitlRequestId','turnId','userMessageId']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','hitlRequestId','turnId','userMessageId']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'hitlRequestId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'hitlRequestId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'turnId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'turnId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'userMessageId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'userMessageId') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'gate-chat-create:' || (("execution_commands"."create_intent"->'owner')->>'turnId')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'sync_resolver' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','syncAttemptId','operationAttemptId','promptOrdinal']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','syncAttemptId','operationAttemptId','promptOrdinal']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'syncAttemptId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'syncAttemptId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'operationAttemptId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'operationAttemptId') BETWEEN 1 AND 128 AND CASE WHEN jsonb_typeof(("execution_commands"."create_intent"->'owner')->'promptOrdinal') = 'number' THEN (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')::numeric BETWEEN 0 AND 9007199254740991 AND (("execution_commands"."create_intent"->'owner')->>'promptOrdinal') ~ '^[0-9]+$' ELSE false END AND "execution_commands"."create_intent"->>'operationKey' = 'sync-resolver-create:' || (("execution_commands"."create_intent"->'owner')->>'syncAttemptId') || ':' || (("execution_commands"."create_intent"->'owner')->>'promptOrdinal')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'flow_resume' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','runSessionId','sourceIncarnationId']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','runSessionId','sourceIncarnationId']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'runSessionId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'runSessionId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'sourceIncarnationId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'sourceIncarnationId') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'flow_resume-create:' || (("execution_commands"."create_intent"->'owner')->>'sourceIncarnationId')) OR (("execution_commands"."create_intent"->'owner')->>'variant' = 'scratch_resume' AND ("execution_commands"."create_intent"->'owner') ?& ARRAY['variant','runSessionId','sourceIncarnationId']::text[] AND ("execution_commands"."create_intent"->'owner') - ARRAY['variant','runSessionId','sourceIncarnationId']::text[] = '{}'::jsonb AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'variant') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'variant') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'runSessionId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'runSessionId') BETWEEN 1 AND 128 AND jsonb_typeof(("execution_commands"."create_intent"->'owner')->'sourceIncarnationId') = 'string' AND length(("execution_commands"."create_intent"->'owner')->>'sourceIncarnationId') BETWEEN 1 AND 128 AND "execution_commands"."create_intent"->>'operationKey' = 'scratch_resume-create:' || (("execution_commands"."create_intent"->'owner')->>'sourceIncarnationId')))
        WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'agent' THEN
          (("execution_commands"."create_intent"->'owner') - ARRAY['variant','turnId','promptOrdinal']) = '{}'::jsonb
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'turnId') = 'string'
          AND length("execution_commands"."create_intent"->'owner'->>'turnId') BETWEEN 1 AND 128
          AND ("execution_commands"."create_intent"->'owner'->>'promptOrdinal') ~ '^(0|[1-9][0-9]*)$'
          AND "execution_commands"."create_intent"->>'operationKey' = 'agent-create:' || ("execution_commands"."create_intent"->'owner'->>'turnId') || ':' || ("execution_commands"."create_intent"->'owner'->>'promptOrdinal')
        WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'librarian' THEN
          (("execution_commands"."create_intent"->'owner') - ARRAY['variant','turnId','promptOrdinal']) = '{}'::jsonb
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'turnId') = 'string'
          AND length("execution_commands"."create_intent"->'owner'->>'turnId') BETWEEN 1 AND 128
          AND ("execution_commands"."create_intent"->'owner'->>'promptOrdinal') ~ '^(0|[1-9][0-9]*)$'
          AND "execution_commands"."create_intent"->>'operationKey' = 'librarian-create:' || ("execution_commands"."create_intent"->'owner'->>'turnId') || ':' || ("execution_commands"."create_intent"->'owner'->>'promptOrdinal')
        ELSE jsonb_typeof("execution_commands"."create_intent"->'owner'->'nodeAttemptId') = 'string'
        AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'node' THEN
          (("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','promptOrdinal']) = '{}'::jsonb
          AND ("execution_commands"."create_intent"->'owner'->>'promptOrdinal') ~ '^(0|[1-9][0-9]*)$'
          AND "execution_commands"."create_intent"->>'operationKey' = 'flow-create:node:' || ("execution_commands"."create_intent"->'owner'->>'nodeAttemptId') || ':' || ("execution_commands"."create_intent"->'owner'->>'promptOrdinal')
        ELSE (("execution_commands"."create_intent"->'owner') - ARRAY['variant','nodeAttemptId','gateId','evaluationId']) = '{}'::jsonb
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'gateId') = 'string'
          AND jsonb_typeof("execution_commands"."create_intent"->'owner'->'evaluationId') = 'string'
          AND "execution_commands"."create_intent"->>'operationKey' = 'flow-create:' || ("execution_commands"."create_intent"->'owner'->>'variant') || ':' || ("execution_commands"."create_intent"->'owner'->>'evaluationId') END END
        AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' IN ('scratch', 'package_scratch') THEN
          jsonb_typeof("execution_commands"."create_intent"->'continuation') = 'object'
          AND "execution_commands"."create_intent"->'continuation' ?& ARRAY['version','kind','sourceMessageId','payload']
          AND (("execution_commands"."create_intent"->'continuation') - ARRAY['version','kind','sourceMessageId','payload','recoveryState']) = '{}'::jsonb
          AND "execution_commands"."create_intent"->'continuation'->'version' = '1'::jsonb
          AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'scratch' THEN "execution_commands"."create_intent"->'continuation'->>'kind' IN ('initial','recovery') ELSE "execution_commands"."create_intent"->'continuation'->>'kind' IN ('package_initial','package_recovery') END
          AND CASE WHEN "execution_commands"."create_intent"->'continuation'->>'kind' IN ('recovery','package_recovery') THEN
            jsonb_typeof("execution_commands"."create_intent"->'continuation'->'recoveryState') = 'object'
            AND "execution_commands"."create_intent"->'continuation'->'recoveryState' ?& ARRAY['status','currentStepId','resumeRequestedAt']
            AND (("execution_commands"."create_intent"->'continuation'->'recoveryState') - ARRAY['status','currentStepId','resumeRequestedAt']) = '{}'::jsonb
            AND "execution_commands"."create_intent"->'continuation'->'recoveryState'->>'status' IN ('Crashed','NeedsInputIdle')
            AND ("execution_commands"."create_intent"->'continuation'->'recoveryState'->'currentStepId' = 'null'::jsonb OR jsonb_typeof("execution_commands"."create_intent"->'continuation'->'recoveryState'->'currentStepId') = 'string')
            AND ("execution_commands"."create_intent"->'continuation'->'recoveryState'->'resumeRequestedAt' = 'null'::jsonb OR jsonb_typeof("execution_commands"."create_intent"->'continuation'->'recoveryState'->'resumeRequestedAt') = 'string')
          ELSE NOT ("execution_commands"."create_intent"->'continuation' ? 'recoveryState') END
          AND ("execution_commands"."create_intent"->'continuation'->'sourceMessageId' = 'null'::jsonb OR jsonb_typeof("execution_commands"."create_intent"->'continuation'->'sourceMessageId') = 'string' AND length("execution_commands"."create_intent"->'continuation'->>'sourceMessageId') BETWEEN 1 AND 128)
          AND ("execution_commands"."create_intent"->'continuation'->'payload' = 'null'::jsonb OR jsonb_typeof("execution_commands"."create_intent"->'continuation'->'payload') = 'object'
            AND "execution_commands"."create_intent"->'continuation'->'payload' ?& ARRAY['stepId','prompt']
            AND (("execution_commands"."create_intent"->'continuation'->'payload') - ARRAY['stepId','prompt','contentBlocks','readOnlyTurn','nodeAttemptId']) = '{}'::jsonb
            AND jsonb_typeof("execution_commands"."create_intent"->'continuation'->'payload'->'stepId') = 'string'
            AND jsonb_typeof("execution_commands"."create_intent"->'continuation'->'payload'->'prompt') = 'string'
            AND length("execution_commands"."create_intent"->'continuation'->'payload'->>'prompt') <= 1000000)
        WHEN "execution_commands"."create_intent"->'owner'->>'variant' = 'sync_resolver' THEN
          jsonb_typeof("execution_commands"."create_intent"->'continuation') = 'object'
          AND "execution_commands"."create_intent"->'continuation' ?& ARRAY['version','kind','prompt','runnerTier']
          AND (("execution_commands"."create_intent"->'continuation') - ARRAY['version','kind','prompt','runnerTier']) = '{}'::jsonb
          AND "execution_commands"."create_intent"->'continuation'->'version' = '1'::jsonb
          AND "execution_commands"."create_intent"->'continuation'->>'kind' = 'sync_resolver'
          AND jsonb_typeof("execution_commands"."create_intent"->'continuation'->'runnerTier') = 'string'
          AND length("execution_commands"."create_intent"->'continuation'->>'runnerTier') BETWEEN 1 AND 128
          AND jsonb_typeof("execution_commands"."create_intent"->'continuation'->'prompt') = 'object'
          AND "execution_commands"."create_intent"->'continuation'->'prompt' ?& ARRAY['stepId','prompt']
          AND (("execution_commands"."create_intent"->'continuation'->'prompt') - ARRAY['stepId','prompt']) = '{}'::jsonb
          AND "execution_commands"."create_intent"->'continuation'->'prompt'->>'stepId' = 'sync'
          AND jsonb_typeof("execution_commands"."create_intent"->'continuation'->'prompt'->'prompt') = 'string'
          AND length("execution_commands"."create_intent"->'continuation'->'prompt'->>'prompt') <= 1000000
        ELSE NOT ("execution_commands"."create_intent" ? 'continuation') END
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
        AND CASE WHEN "execution_commands"."create_intent"->'owner'->>'variant' IN ('agent', 'librarian', 'scratch', 'package_scratch', 'gate_chat', 'sync_resolver', 'flow_resume', 'scratch_resume') THEN
          NOT (("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'payload' ? 'nodeAttemptId')
        ELSE ("execution_commands"."create_intent"->>'requestCanonicalJson')::jsonb->'payload'->>'nodeAttemptId' = "execution_commands"."create_intent"->'owner'->>'nodeAttemptId' END
      ) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_immutable_session_create_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retiring boolean := OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL;
  compacting boolean;
BEGIN
  IF OLD.create_intent IS NULL THEN
    IF NEW.create_intent IS NOT NULL THEN
      RAISE EXCEPTION 'A private create intent must be admitted atomically with its original command'
        USING ERRCODE='23514',CONSTRAINT='execution_commands_immutable_create_intent';
    END IF;
    RETURN NEW;
  END IF;
  compacting := retiring
    AND OLD.state IN ('succeeded','failed','fenced')
    AND OLD.completed_at IS NOT NULL
    AND NEW.retired_at >= OLD.completed_at + interval '7 days'
    AND NEW.create_intent IS NULL
    AND NEW.request_canonical_json IS NULL
    AND NEW.receipt_evidence IS NULL
    AND NEW.result IS NULL AND NEW.last_error IS NULL
    AND NEW.payload = '{}'::jsonb
    AND NEW.updated_at = NEW.retired_at
    AND ROW(NEW.state,NEW.completed_at) IS NOT DISTINCT FROM ROW(OLD.state,OLD.completed_at)
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=OLD.run_id
      AND r.status NOT IN ('Done','Failed','Crashed','Abandoned')
      AND NOT(r.run_kind='librarian' AND r.status='NeedsInputIdle'));
  IF ROW(NEW.id,NEW.run_id,NEW.execution_assignment_id,NEW.execution_host_id,
      NEW.assignment_epoch,NEW.kind,NEW.target_session_id,NEW.created_at,
      NEW.owner_kind,NEW.owner_ref,NEW.logical_operation_key,NEW.request_schema,NEW.request_sha256)
    IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.execution_assignment_id,OLD.execution_host_id,
      OLD.assignment_epoch,OLD.kind,OLD.target_session_id,OLD.created_at,
      OLD.owner_kind,OLD.owner_ref,OLD.logical_operation_key,OLD.request_schema,OLD.request_sha256)
    OR ((NEW.create_intent IS DISTINCT FROM OLD.create_intent
      OR NEW.request_canonical_json IS DISTINCT FROM OLD.request_canonical_json
      OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at) AND NOT compacting)
  THEN
    RAISE EXCEPTION 'The admitted private create request, owner and continuation are immutable'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_immutable_create_intent';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_immutable_create_intent
BEFORE UPDATE ON execution_commands FOR EACH ROW
EXECUTE FUNCTION guard_immutable_session_create_intent();
