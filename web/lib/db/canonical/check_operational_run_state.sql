CREATE OR REPLACE FUNCTION public.check_operational_run_state()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  receipt jsonb := NEW.operational_terminal;
  cleanup jsonb := NEW.operational_cleanup;
  baseline jsonb := NEW.operational_integrity_baseline;
BEGIN
  IF NEW.agent_kind IS DISTINCT FROM 'operational' THEN RETURN NEW; END IF;
  IF baseline IS NOT NULL AND NOT (
    jsonb_typeof(baseline) = 'object' AND baseline ?& ARRAY['version','generation','resourceKind','capturedAt','head','branch','indexDigest','source','platform'] AND
    baseline->>'generation' ~ '^[0-9]{1,9}$' AND jsonb_typeof(baseline->'generation') = 'number' AND
    baseline->>'resourceKind' IN ('worktree','ephemeral_checkout','plain_directory','shared_repository') AND
    pg_input_is_valid(baseline->>'capturedAt', 'timestamp with time zone')
  ) IS TRUE THEN
    RAISE EXCEPTION 'invalid operational integrity baseline' USING ERRCODE='23514', CONSTRAINT='runs_operational_baseline_check';
  END IF;
  IF receipt IS NOT NULL THEN
    IF NOT (receipt ?& ARRAY['version','status','cause','effectiveOutcome','successful','validation','integrity','baselineGeneration','resultRevision','reasonCodes','evidenceIds'] AND
      length(receipt->>'cause') BETWEEN 1 AND 256 AND
      (receipt->'resultRevision' = 'null'::jsonb OR jsonb_typeof(receipt->'resultRevision') = 'number' AND receipt->>'resultRevision' ~ '^[1-9][0-9]{0,8}$') AND
      CASE NEW.status
        WHEN 'Done' THEN receipt->>'effectiveOutcome' = 'success'
        WHEN 'Failed' THEN receipt->>'effectiveOutcome' IN ('partial','blocked','failed')
        WHEN 'Crashed' THEN receipt->>'effectiveOutcome' = 'crashed'
        WHEN 'Abandoned' THEN receipt->>'effectiveOutcome' = 'cancelled'
        ELSE false
      END) IS TRUE THEN
      RAISE EXCEPTION 'invalid operational terminal decision' USING ERRCODE='23514', CONSTRAINT='runs_operational_terminal_check';
    END IF;
  END IF;
  IF cleanup IS NOT NULL THEN
    IF NOT (cleanup ?& ARRAY['version','resourceKind','workspace','state','revision','armedAt','attempts','dueAt','errorCode','evidenceIds','removedAt','releasedAt','lease','rearmReceipt'] AND
      NEW.status IN ('Done','Failed','Crashed','Abandoned') AND
      pg_input_is_valid(cleanup->>'armedAt', 'timestamp with time zone') AND
      (cleanup->'dueAt' = 'null'::jsonb OR pg_input_is_valid(cleanup->>'dueAt', 'timestamp with time zone')) AND
      (cleanup->>'resourceKind' <> 'worktree' OR cleanup->'lease' = 'null'::jsonb) AND
      (cleanup->'lease' = 'null'::jsonb OR
        length(cleanup->'lease'->>'id') > 0 AND length(cleanup->'lease'->>'owner') > 0 AND pg_input_is_valid(cleanup->'lease'->>'expiresAt', 'timestamp with time zone'))
    ) IS TRUE THEN
      RAISE EXCEPTION 'invalid operational cleanup intent' USING ERRCODE='23514', CONSTRAINT='runs_operational_cleanup_check';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
