ALTER TABLE "task_launch_intents" DROP CONSTRAINT "task_launch_intents_preparation_check";--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_preparation_check" CHECK ((("task_launch_intents"."preparation_identity" IS NULL AND "task_launch_intents"."preparation_phase" IS NULL) OR (
        jsonb_typeof("task_launch_intents"."preparation_identity")='object' AND "task_launch_intents"."preparation_identity" ?& ARRAY['runId','taskAttemptNumber','branch','parentRepoPath','worktreePath','resourceId','incarnationId','baseCommit','inputDigest','settingsDigest']
        AND length("task_launch_intents"."preparation_identity"->>'runId') BETWEEN 1 AND 256
        AND jsonb_typeof("task_launch_intents"."preparation_identity"->'taskAttemptNumber')='number' AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric>0 AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric=trunc(("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric)
        AND "task_launch_intents"."preparation_identity"->>'resourceId' ~ '^[0-9a-f]{64}$' AND length("task_launch_intents"."preparation_identity"->>'incarnationId') BETWEEN 1 AND 256
        AND (
          "task_launch_intents"."preparation_identity"->'version'='3'::jsonb AND "task_launch_intents"."preparation_identity"->'worktreePath'='null'::jsonb
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
          AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
        AND "task_launch_intents"."preparation_phase" IN ('reserved','checkout_ready','materializing','materialized','run_bound') AND octet_length("task_launch_intents"."preparation_identity"::text)<=16384
      )) IS TRUE AND ("task_launch_intents"."cleanup_state" IS NULL OR "task_launch_intents"."cleanup_state" IN ('pending','removed','retained')));
--> statement-breakpoint
CREATE FUNCTION guard_addressed_task_launch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    WHERE run.id = NEW.run_id
      AND run.task_launch_intent_id = NEW.id
      AND workspace.project_id = NEW.project_id
      AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_host_id = NEW.effective_execution_host_id
      AND workspace.branch = NEW.preparation_identity->>'branch'
      AND workspace.base_commit = NEW.preparation_identity->>'baseCommit'
      AND assignment.id = run.execution_assignment_id
      AND assignment.execution_host_id = NEW.effective_execution_host_id
      AND assignment.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Addressed launch binding requires the accepted host, checkout and assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_task_launch_binding';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER addressed_task_launch_binding_guard
BEFORE UPDATE OF preparation_phase, run_id ON task_launch_intents
FOR EACH ROW
WHEN (NEW.preparation_identity->'version'='3'::jsonb
  AND NEW.preparation_phase='run_bound'
  AND OLD.preparation_phase IS DISTINCT FROM NEW.preparation_phase)
EXECUTE FUNCTION guard_addressed_task_launch_binding();
