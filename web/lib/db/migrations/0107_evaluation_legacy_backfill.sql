-- M46 (ADR-139) legacy Experiment -> Evaluation Study backfill.
--
-- Lossless, idempotent, parity-asserting. Preserves every experiments /
-- experiment_runs row or RAISEs (rolling back the whole migration) — no lossy
-- guess, no destructive drop (the legacy tables survive the M46 rollback
-- window; the deferred 0108 contract migration drops them after sign-off).
--
-- The logic lives in a retained idempotent function so the T5.4 rollout
-- "verify parity" step can re-run it, and integration tests can seed a
-- realistic 0090 dataset and invoke it. On an empty DB (fresh container) the
-- one-time invocation below is a no-op.
CREATE OR REPLACE FUNCTION evaluation_backfill_from_experiments()
RETURNS void AS $fn$
DECLARE
  exp RECORD;
  var JSONB;
  er RECORD;
  adv JSONB;
  v_status TEXT;
  v_archived_reason TEXT;
  v_recipe_id TEXT;
  v_exec_id TEXT;
  v_advisories JSONB;
  v_human JSONB;
  v_outcome TEXT;
  v_winner_key TEXT;
  v_participant_ids JSONB;
  v_execution_ids JSONB;
  v_run_count INT;
  v_participant_count INT;
BEGIN
  FOR exp IN SELECT * FROM experiments LOOP
    -- Idempotent: skip an already-migrated Experiment.
    IF EXISTS (
      SELECT 1 FROM evaluation_studies WHERE legacy_experiment_id = exp.id
    ) THEN
      CONTINUE;
    END IF;

    -- Fixed status mapping. No state is inferred from current Run rows.
    v_archived_reason := NULL;
    CASE exp.status
      WHEN 'draft' THEN v_status := 'draft';
      WHEN 'running' THEN v_status := 'open';
      WHEN 'comparable' THEN v_status := 'open';
      WHEN 'concluded' THEN v_status := 'decided';
      WHEN 'abandoned' THEN
        v_status := 'archived';
        v_archived_reason := 'legacy_abandoned';
      ELSE
        RAISE EXCEPTION
          'evaluation backfill: unknown experiment status % (experiment %)',
          exp.status, exp.id;
    END CASE;

    -- 1. Study preserves the Experiment id (deep-link parity) + verbatim JSON.
    INSERT INTO evaluation_studies (
      id, project_id, task_id, title, purpose, status, version,
      created_by_user_id, legacy_experiment_id, archived_reason,
      legacy_snapshot, created_at, updated_at, decided_at, archived_at
    ) VALUES (
      exp.id, exp.project_id, exp.task_id, exp.title, exp.description, v_status,
      1, exp.created_by_user_id, exp.id, v_archived_reason,
      to_jsonb(exp), exp.created_at, exp.updated_at, exp.concluded_at,
      exp.abandoned_at
    );

    -- 2. One immutable recipe per variant (deterministic legacy key + digest).
    IF jsonb_typeof(exp.variants) <> 'array' THEN
      RAISE EXCEPTION
        'evaluation backfill: experiment % variants is not an array', exp.id;
    END IF;
    FOR var IN SELECT jsonb_array_elements(exp.variants) LOOP
      INSERT INTO evaluation_recipes (
        id, study_id, key, label, definition, definition_digest,
        replicate_group, version, created_at
      ) VALUES (
        gen_random_uuid()::text, exp.id, 'legacy:' || (var->>'key'),
        COALESCE(var->>'label', var->>'key'), var, md5(var::text),
        var->>'key', 1, exp.created_at
      );
    END LOOP;

    -- 3. One launched participant per experiment_run (immutable provenance).
    FOR er IN
      SELECT * FROM experiment_runs WHERE experiment_id = exp.id
    LOOP
      SELECT id INTO v_recipe_id FROM evaluation_recipes
       WHERE study_id = exp.id AND key = 'legacy:' || er.variant_key;
      IF v_recipe_id IS NULL THEN
        RAISE EXCEPTION
          'evaluation backfill: experiment_run % cites unknown variant % (experiment %)',
          er.id, er.variant_key, exp.id;
      END IF;
      INSERT INTO evaluation_participants (
        id, study_id, run_id, source_type, recipe_id, label, display_order,
        replicate_group, replicate_ordinal, launch_reason, run_identity,
        joined_at
      ) VALUES (
        gen_random_uuid()::text, exp.id, er.run_id, 'launched', v_recipe_id,
        er.variant_key || ' #' || er.replicate_ordinal, 0, er.variant_key,
        er.replicate_ordinal,
        -- launched participant reasons are ('initial','manual_relaunch',
        -- 'replicate'); the legacy 'budget_restart' has no evaluation analogue.
        CASE er.launch_reason
          WHEN 'budget_restart' THEN 'manual_relaunch'
          ELSE er.launch_reason
        END,
        jsonb_build_object(
          'runId', er.run_id,
          'taskId', exp.task_id,
          'baseCommit', er.base_commit,
          'capturedAt', now()::text,
          'legacyVariantKey', er.variant_key,
          'legacyReplicateOrdinal', er.replicate_ordinal,
          'legacyLaunchReason', er.launch_reason,
          'legacyDiffSnapshotBytes', er.diff_snapshot_bytes,
          'legacyDiffSnapshotTruncated', er.diff_snapshot_truncated,
          'legacyHasDiffFilesSummary', (er.diff_files_summary IS NOT NULL),
          'legacyHasMaterializationDelta', (er.materialization_delta IS NOT NULL)
        ),
        er.created_at
      );
    END LOOP;

    -- Per-Study member coverage parity.
    SELECT count(*) INTO v_run_count
      FROM experiment_runs WHERE experiment_id = exp.id;
    SELECT count(*) INTO v_participant_count
      FROM evaluation_participants WHERE study_id = exp.id;
    IF v_run_count <> v_participant_count THEN
      RAISE EXCEPTION
        'evaluation backfill parity: experiment % has % runs but % participants',
        exp.id, v_run_count, v_participant_count;
    END IF;

    -- 5a. Normalize judge advisories into ONE legacy Evaluation Execution
    -- (terminal Partial, reason legacy_advisory — never Completed) with one
    -- attempt per advisory. The full advisory is preserved verbatim in the
    -- sealed result; unknown method/criterion structure is NOT fabricated.
    v_advisories := exp.verdict -> 'judgeAdvisories';
    v_exec_id := NULL;
    IF v_advisories IS NOT NULL
       AND jsonb_typeof(v_advisories) = 'array'
       AND jsonb_array_length(v_advisories) > 0 THEN
      v_exec_id := gen_random_uuid()::text;
      INSERT INTO evaluation_executions (
        id, study_id, method_revision_id, evidence_snapshot_id, status, version,
        terminal_reason, requested_by_user_id, requested_at, started_at,
        terminal_at
      ) VALUES (
        v_exec_id, exp.id, NULL, NULL, 'partial', 1, 'legacy_advisory',
        exp.concluded_by_user_id,
        COALESCE(exp.concluded_at, exp.updated_at),
        COALESCE(exp.concluded_at, exp.updated_at),
        COALESCE(exp.concluded_at, exp.updated_at)
      );
      FOR adv IN SELECT jsonb_array_elements(v_advisories) LOOP
        INSERT INTO evaluation_judge_attempts (
          id, execution_id, role, ordinal, retry_ordinal, agent_id,
          agent_revision, agent_run_id, status, reason, sealed_result,
          result_digest, enqueued_at, running_at, terminal_at
        ) VALUES (
          gen_random_uuid()::text, v_exec_id, 'legacy',
          COALESCE((adv->>'advisoryOrdinal')::int, 0), 0, NULL, 'legacy',
          -- Only link a still-present Run to avoid an FK violation.
          (SELECT r.id FROM runs r WHERE r.id = adv->>'agentRunId'),
          'completed', 'legacy_advisory', adv, md5(adv::text),
          COALESCE((adv->>'createdAt')::timestamptz, exp.concluded_at),
          COALESCE((adv->>'createdAt')::timestamptz, exp.concluded_at),
          COALESCE((adv->>'createdAt')::timestamptz, exp.concluded_at)
        );
      END LOOP;
    END IF;

    -- 5b. Concluded Experiments become an append-only human verdict. Without a
    -- cited execution it is a zero-citation verdict carrying the explicit
    -- no-evaluation-evidence acknowledgement.
    IF exp.status = 'concluded' THEN
      v_human := exp.verdict -> 'human';
      v_outcome := COALESCE(v_human->>'outcome', 'inconclusive');
      IF v_outcome NOT IN ('winner', 'tie', 'inconclusive') THEN
        v_outcome := 'inconclusive';
      END IF;
      v_winner_key := v_human->>'winnerVariantKey';

      IF v_outcome = 'winner' AND v_winner_key IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(p.id), '[]'::jsonb) INTO v_participant_ids
          FROM evaluation_participants p
          JOIN evaluation_recipes r ON r.id = p.recipe_id
         WHERE p.study_id = exp.id AND r.key = 'legacy:' || v_winner_key;
      ELSE
        SELECT COALESCE(jsonb_agg(p.id), '[]'::jsonb) INTO v_participant_ids
          FROM evaluation_participants p WHERE p.study_id = exp.id;
      END IF;

      IF v_exec_id IS NOT NULL THEN
        v_execution_ids := jsonb_build_array(v_exec_id);
      ELSE
        v_execution_ids := '[]'::jsonb;
      END IF;

      INSERT INTO evaluation_human_verdicts (
        id, study_id, supersedes_id, outcome, participant_ids, execution_ids,
        no_evaluation_evidence_ack, rationale, created_by_user_id, created_at
      ) VALUES (
        gen_random_uuid()::text, exp.id, NULL, v_outcome, v_participant_ids,
        v_execution_ids, (v_exec_id IS NULL), v_human->>'comment',
        exp.concluded_by_user_id, COALESCE(exp.concluded_at, exp.updated_at)
      );
    END IF;
  END LOOP;

  -- Global study parity: every Experiment produced exactly one Study.
  IF (SELECT count(*) FROM experiments)
     <> (SELECT count(*) FROM evaluation_studies
          WHERE legacy_experiment_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'evaluation backfill parity: % experiments but % migrated studies',
      (SELECT count(*) FROM experiments),
      (SELECT count(*) FROM evaluation_studies
        WHERE legacy_experiment_id IS NOT NULL);
  END IF;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT evaluation_backfill_from_experiments();
