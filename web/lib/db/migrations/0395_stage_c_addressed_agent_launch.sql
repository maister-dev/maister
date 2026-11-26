ALTER TABLE "task_launch_intents" DROP CONSTRAINT "task_launch_intents_host_selection_shape_check";--> statement-breakpoint
ALTER TABLE "task_launch_intents" DROP CONSTRAINT "task_launch_intents_preparation_check";--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_host_selection_shape_check" CHECK ((
        ("task_launch_intents"."requested_execution_host_id" IS NULL AND "task_launch_intents"."effective_execution_host_id" IS NULL
          AND "task_launch_intents"."execution_host_provenance" IS NULL AND "task_launch_intents"."execution_host_eligibility_revision" IS NULL)
        OR
        ("task_launch_intents"."effective_execution_host_id" IS NOT NULL
          AND "task_launch_intents"."execution_host_eligibility_revision" ~ '^[0-9a-f]{64}$'
          AND (("task_launch_intents"."execution_host_provenance" = 'explicit'
              AND "task_launch_intents"."requested_execution_host_id" = "task_launch_intents"."effective_execution_host_id")
            OR ("task_launch_intents"."execution_host_provenance" IN ('projectDefault', 'instanceDefault')
              AND "task_launch_intents"."requested_execution_host_id" IS NULL)
            OR ("task_launch_intents"."execution_host_provenance" = 'sharedRoot'
              AND ("task_launch_intents"."requested_execution_host_id" IS NULL OR "task_launch_intents"."requested_execution_host_id" = "task_launch_intents"."effective_execution_host_id"))))
      ) IS TRUE);--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_preparation_check" CHECK ((("task_launch_intents"."preparation_identity" IS NULL AND "task_launch_intents"."preparation_phase" IS NULL) OR (
        jsonb_typeof("task_launch_intents"."preparation_identity")='object' AND "task_launch_intents"."preparation_identity" ?& ARRAY['runId','taskAttemptNumber','branch','parentRepoPath','worktreePath','resourceId','incarnationId','baseCommit','inputDigest','settingsDigest']
        AND length("task_launch_intents"."preparation_identity"->>'runId') BETWEEN 1 AND 256
        AND jsonb_typeof("task_launch_intents"."preparation_identity"->'taskAttemptNumber')='number' AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric>0 AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric=trunc(("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric)
        AND "task_launch_intents"."preparation_identity"->>'resourceId' ~ '^[0-9a-f]{64}$' AND length("task_launch_intents"."preparation_identity"->>'incarnationId') BETWEEN 1 AND 256
        AND (
          "task_launch_intents"."preparation_identity"->'version' IN ('3'::jsonb,'4'::jsonb) AND "task_launch_intents"."preparation_identity"->'worktreePath'='null'::jsonb
          OR jsonb_typeof("task_launch_intents"."preparation_identity"->'worktreePath')='string' AND length("task_launch_intents"."preparation_identity"->>'worktreePath') BETWEEN 1 AND 4096
        )
        AND ("task_launch_intents"."preparation_identity"->>'baseCommit' IS NOT DISTINCT FROM "task_launch_intents"."settings_snapshot"->>'baseCommit')
        AND "task_launch_intents"."preparation_identity"->>'inputDigest'="task_launch_intents"."input_digest" AND "task_launch_intents"."preparation_identity"->>'settingsDigest'="task_launch_intents"."settings_digest"
        AND ("task_launch_intents"."preparation_identity"->'version'='1'::jsonb AND "task_launch_intents"."settings_snapshot"->>'kind'='flow'
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string' AND jsonb_typeof("task_launch_intents"."preparation_identity"->'parentRepoPath')='string'
          AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
          OR "task_launch_intents"."preparation_identity"->'version'='2'::jsonb AND "task_launch_intents"."preparation_identity"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->>'kind'='agent'
          AND "task_launch_intents"."preparation_identity"->>'workspace'="task_launch_intents"."settings_snapshot"->>'workspace'
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'runtimePath')='string' AND length("task_launch_intents"."preparation_identity"->>'runtimePath') BETWEEN 1 AND 4096
          AND ("task_launch_intents"."preparation_identity"->>'workspace'='none' AND "task_launch_intents"."preparation_identity"->'parentRepoPath'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'baseCommit'='null'::jsonb
            OR "task_launch_intents"."preparation_identity"->>'workspace' IN ('repo_read','worktree') AND jsonb_typeof("task_launch_intents"."preparation_identity"->'parentRepoPath')='string'
              AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
              AND ("task_launch_intents"."preparation_identity"->>'workspace'='repo_read' AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb OR "task_launch_intents"."preparation_identity"->>'workspace'='worktree' AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string'))
          OR "task_launch_intents"."preparation_identity"->'version'='3'::jsonb AND "task_launch_intents"."settings_snapshot"->>'kind'='flow'
          AND "task_launch_intents"."preparation_identity"->'parentRepoPath'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'worktreePath'='null'::jsonb
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'executionHostId')='string'
          AND "task_launch_intents"."preparation_identity"->>'executionHostId'="task_launch_intents"."effective_execution_host_id"
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string' AND length("task_launch_intents"."preparation_identity"->>'branch') BETWEEN 1 AND 256
          AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
          OR "task_launch_intents"."preparation_identity"->'version'='4'::jsonb AND "task_launch_intents"."preparation_identity"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->>'kind'='agent'
          AND "task_launch_intents"."preparation_identity"->>'workspace'="task_launch_intents"."settings_snapshot"->>'workspace'
          AND "task_launch_intents"."preparation_identity"->'parentRepoPath'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'worktreePath'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'runtimePath'='null'::jsonb
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'executionHostId')='string'
          AND "task_launch_intents"."preparation_identity"->>'executionHostId'="task_launch_intents"."effective_execution_host_id"
          AND ("task_launch_intents"."preparation_identity"->>'workspace'='none' AND "task_launch_intents"."preparation_identity"->'baseCommit'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb
            OR "task_launch_intents"."preparation_identity"->>'workspace' IN ('repo_read','worktree') AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
              AND ("task_launch_intents"."preparation_identity"->>'workspace'='repo_read' AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb
                OR "task_launch_intents"."preparation_identity"->>'workspace'='worktree' AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string' AND length("task_launch_intents"."preparation_identity"->>'branch') BETWEEN 1 AND 256)))
        AND "task_launch_intents"."preparation_phase" IN ('reserved','checkout_ready','materializing','materialized','run_bound') AND octet_length("task_launch_intents"."preparation_identity"::text)<=16384
      )) IS TRUE AND ("task_launch_intents"."cleanup_state" IS NULL OR "task_launch_intents"."cleanup_state" IN ('pending','removed','retained')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phases text[]:=ARRAY['reserved','checkout_ready','materializing','materialized','run_bound'];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.reservation_lane='concurrent' AND NOT (
      NEW.principal_kind='session_user' AND NEW.basis->>'kind'='manual'
      OR NEW.principal_kind='system' AND NEW.basis->>'kind'='automatic'
        AND NEW.settings_snapshot->'serverExecution'->>'kind'='evaluation'
        AND NEW.settings_snapshot->'serverExecution'->>'projectId'=NEW.project_id
        AND NEW.settings_snapshot->'serverExecution'->>'taskId'=NEW.task_id
        AND NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationBatchItemId'=NEW.settings_snapshot->'serverExecution'->>'id'
        AND EXISTS(SELECT 1 FROM evaluation_launch_batch_items item
          JOIN evaluation_launch_batches batch ON batch.id=item.batch_id
          JOIN evaluation_studies study ON study.id=batch.study_id
          WHERE item.id=NEW.settings_snapshot->'serverExecution'->>'id' AND item.status='launching'
            AND study.id=NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationStudyId'
            AND study.project_id=NEW.project_id AND study.task_id=NEW.task_id)
    ) IS TRUE THEN
      RAISE EXCEPTION 'Concurrent delivery requires its interactive decision or current controlled evaluation source'
        USING ERRCODE='23514',CONSTRAINT='task_launch_concurrent_authority';
    END IF;
    IF NEW.preparation_identity IS NOT NULL OR NEW.preparation_phase IS NOT NULL OR NEW.cleanup_state IS NOT NULL THEN
      RAISE EXCEPTION 'A new launch cannot fabricate preparation progress'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_initial';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.preparation_identity IS NOT NULL AND OLD.preparation_identity IS DISTINCT FROM NEW.preparation_identity THEN
    RAISE EXCEPTION 'Launch preparation identity is immutable'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_immutable';
  END IF;
  IF OLD.preparation_identity IS NULL AND NEW.preparation_identity IS NOT NULL THEN
    IF NEW.state<>'preparing' OR NEW.run_id IS NOT NULL OR NEW.preparation_phase<>'reserved'
      OR NEW.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Preparation allocation requires a current unbound worker claim'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  ELSIF OLD.preparation_phase IS DISTINCT FROM NEW.preparation_phase THEN
    IF OLD.state<>'preparing' OR OLD.lease_expires_at<=clock_timestamp()
      OR OLD.lease_token IS DISTINCT FROM NEW.lease_token AND NEW.state='preparing'
      OR (array_position(phases,NEW.preparation_phase)<>array_position(phases,OLD.preparation_phase)+1
        AND NOT (NEW.preparation_identity->'version'='2'::jsonb AND NEW.preparation_identity->>'kind'='agent' AND OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound')
        AND NOT (
          OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound'
          AND EXISTS (
            SELECT 1
            FROM workspaces workspace
            JOIN execution_commands command ON command.target_session_id = workspace.id
              AND command.run_id = workspace.run_id
              AND command.execution_host_id = workspace.execution_host_id
              AND command.execution_assignment_id = workspace.preparation_assignment_id
            WHERE workspace.run_id = NEW.run_id
              AND workspace.project_id = NEW.project_id
              AND workspace.ownership_kind = 'host_owned'
              AND workspace.execution_workspace_id IS NULL
              AND workspace.workspace_input_digest = NEW.input_digest
              AND workspace.base_commit IS NOT DISTINCT FROM (NEW.preparation_identity->>'baseCommit')
              AND command.kind = 'workspace.prepare'
              AND command.state = 'queued'
          )
        ))
      OR NEW.preparation_phase='run_bound' AND (NEW.state<>'run_bound' OR NEW.run_id IS DISTINCT FROM NEW.preparation_identity->>'runId') THEN
      RAISE EXCEPTION 'Preparation publication requires its current owner and next phase'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  END IF;
  IF OLD.cleanup_state='removed' AND NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state
    OR OLD.cleanup_state IN ('pending','retained') AND NEW.cleanup_state IS NULL
    OR NEW.cleanup_state IS NOT NULL AND NEW.state NOT IN ('held','failed','cancelled','settled') THEN
    RAISE EXCEPTION 'Launch cleanup requires closed execution authority and cannot discard ownership or undo removal'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_cleanup';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_continuation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_launch_intent_id IS NOT NULL AND NEW.status IN ('Running','NeedsInput','HumanWorking')
    AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') AND NOT EXISTS(
      SELECT 1 FROM task_launch_intents intent WHERE intent.id=NEW.task_launch_intent_id
        AND intent.run_id=NEW.id AND intent.state='run_bound' AND (intent.dispatch_receipt IS NOT NULL OR OLD.status='Pending' AND NEW.run_kind='agent' AND intent.preparation_identity->'version' IN ('2'::jsonb,'4'::jsonb) AND intent.settings_snapshot->>'kind'='agent')
    ) THEN
    RAISE EXCEPTION 'Execution continuation must reacquire its original launch reservation'
      USING ERRCODE='23514',CONSTRAINT='task_launch_continuation_reservation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_dispatch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.dispatch_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'A new accepted launch has not dispatched'
      USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_initial';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.dispatch_receipt IS NOT NULL AND OLD.dispatch_receipt IS DISTINCT FROM NEW.dispatch_receipt THEN
      RAISE EXCEPTION 'First dispatch receipt is immutable across continuation epochs'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_immutable';
    END IF;
    IF OLD.dispatch_receipt IS NULL AND NEW.dispatch_receipt IS NOT NULL THEN
      IF OLD.dispatch_committed_at IS NOT NULL OR OLD.state<>'run_bound' OR NEW.state<>'run_bound'
        OR NOT (
          jsonb_typeof(NEW.dispatch_receipt)='object' AND NEW.dispatch_receipt->'version'='1'::jsonb
          AND NEW.dispatch_receipt->>'runId'=NEW.run_id
          AND NEW.dispatch_receipt->>'inputDigest'=NEW.input_digest
          AND NEW.dispatch_receipt->>'settingsDigest'=NEW.settings_digest
          AND (NEW.dispatch_receipt->>'committedAt')::timestamptz=NEW.dispatch_committed_at
          AND NEW.dispatch_receipt-ARRAY['version','runId','assignmentId','assignmentEpoch','inputDigest','settingsDigest','committedAt','preparation','addressedPreparation']='{}'::jsonb
          AND (NEW.settings_snapshot->>'kind'='flow' AND NOT (NEW.dispatch_receipt ?| ARRAY['preparation','addressedPreparation'])
            OR NEW.preparation_identity->'version'='4'::jsonb
              AND NOT (NEW.dispatch_receipt ? 'preparation')
              AND jsonb_typeof(NEW.dispatch_receipt->'addressedPreparation')='object'
              AND (NEW.dispatch_receipt->'addressedPreparation')-ARRAY['workspaceId','handle','generation','materializationGeneration']='{}'::jsonb
              AND EXISTS (
                SELECT 1 FROM workspaces workspace
                JOIN execution_assignments owner ON owner.id=NEW.dispatch_receipt->>'assignmentId'
                JOIN execution_commands prepare ON prepare.target_session_id=workspace.id
                  AND prepare.execution_host_id=workspace.execution_host_id
                  AND prepare.execution_assignment_id=workspace.preparation_assignment_id
                  AND prepare.kind='workspace.prepare' AND prepare.state='succeeded'
                LEFT JOIN workspaces root ON root.id=workspace.root_workspace_id
                WHERE workspace.id=NEW.dispatch_receipt->'addressedPreparation'->>'workspaceId'
                  AND workspace.run_id=NEW.run_id
                  AND workspace.project_id=NEW.project_id
                  AND workspace.ownership_kind='host_owned'
                  AND workspace.removed_at IS NULL
                  AND workspace.execution_host_id=owner.execution_host_id
                  AND workspace.execution_host_id=NEW.effective_execution_host_id
                  AND owner.addressed_stop_requested_at IS NULL
                  AND owner.execution_workspace_id=NEW.dispatch_receipt->'addressedPreparation'->>'handle'
                  AND prepare.result->'workspace'->>'handle'=owner.execution_workspace_id
                  AND (workspace.root_workspace_id IS NULL AND workspace.execution_workspace_id=owner.execution_workspace_id
                    OR root.execution_host_id=workspace.execution_host_id AND root.project_id=workspace.project_id
                      AND root.removed_at IS NULL
                      AND root.execution_workspace_id=prepare.payload->>'parentHandle'
                      AND to_jsonb(root.workspace_generation)=prepare.payload->'parentGeneration')
                  AND to_jsonb(workspace.workspace_generation)=NEW.dispatch_receipt->'addressedPreparation'->'generation'
                  AND to_jsonb(workspace.workspace_materialization_generation)=NEW.dispatch_receipt->'addressedPreparation'->'materializationGeneration'
              )
            OR NEW.settings_snapshot->>'kind'='agent' AND NEW.preparation_identity->'version'='2'::jsonb
              AND NOT (NEW.dispatch_receipt ? 'addressedPreparation') AND jsonb_typeof(NEW.dispatch_receipt->'preparation')='object'
              AND NEW.dispatch_receipt->'preparation'->>'baselineDigest' ~ '^[0-9a-f]{64}$'
              AND NEW.dispatch_receipt->'preparation'->>'materializationDigest' ~ '^[0-9a-f]{64}$'
              AND EXISTS(SELECT 1 FROM agent_preparation_operations preparation JOIN runs prepared_run ON prepared_run.id=preparation.run_id
                WHERE preparation.id=NEW.dispatch_receipt->'preparation'->>'id' AND preparation.run_id=NEW.run_id
                  AND preparation.assignment_id=NEW.dispatch_receipt->>'assignmentId' AND to_jsonb(preparation.assignment_epoch)=NEW.dispatch_receipt->'assignmentEpoch'
                  AND preparation.phase='materialized' AND preparation.lease_expires_at>clock_timestamp()
                  AND preparation.resource_id=NEW.dispatch_receipt->'preparation'->>'resourceId'
                  AND preparation.incarnation=NEW.dispatch_receipt->'preparation'->>'incarnation'
                  AND to_jsonb(preparation.generation)=NEW.dispatch_receipt->'preparation'->'generation'
                  AND prepared_run.operational_integrity_baseline->'generation'=to_jsonb(preparation.generation)))
          AND octet_length(NEW.dispatch_receipt::text)<=8192
          AND EXISTS(SELECT 1 FROM execution_assignments assignment
            WHERE assignment.id=NEW.dispatch_receipt->>'assignmentId' AND assignment.run_id=NEW.run_id
              AND assignment.state='active' AND to_jsonb(assignment.epoch)=NEW.dispatch_receipt->'assignmentEpoch'
              AND EXISTS(SELECT 1 FROM runs owner_run WHERE owner_run.id=NEW.run_id AND owner_run.execution_assignment_id=assignment.id))
        ) IS TRUE THEN
        RAISE EXCEPTION 'First dispatch must bind its current run assignment and exact accepted request'
          USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_owner';
      END IF;
    END IF;
    IF OLD.dispatch_committed_at IS NULL AND NEW.dispatch_committed_at IS NOT NULL AND NEW.dispatch_receipt IS NULL THEN
      RAISE EXCEPTION 'A timestamp alone cannot establish execution commitment'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
