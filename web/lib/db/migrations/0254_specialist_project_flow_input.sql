ALTER TABLE "specialist_input_revisions" DROP CONSTRAINT "specialist_input_revisions_planes_check";--> statement-breakpoint
ALTER TABLE "specialist_assignments" ADD COLUMN "project_task_id" text;--> statement-breakpoint
ALTER TABLE "specialist_assignments" ADD CONSTRAINT "specialist_assignments_project_task_id_tasks_id_fk" FOREIGN KEY ("project_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_assignments_project_task_idx" ON "specialist_assignments" USING btree ("project_task_id") WHERE "specialist_assignments"."project_task_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "specialist_assignments" ADD CONSTRAINT "specialist_assignments_project_task_owner_check" CHECK ("specialist_assignments"."project_task_id" IS NULL OR "specialist_assignments"."project_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "specialist_input_revisions" ADD CONSTRAINT "specialist_input_revisions_planes_check" CHECK ((
    jsonb_typeof("specialist_input_revisions"."objective_input")='object'
    AND "specialist_input_revisions"."objective_input" ?& ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']
    AND "specialist_input_revisions"."objective_input" - ARRAY['objective','expectedOutcome','input','targetIds','inputRefs','constraints','expectedResult','verification']='{}'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'objective')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'objective') BETWEEN 1 AND 8000
    AND "specialist_input_revisions"."objective_input"->>'objective' ~ '[^[:space:]]'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'expectedOutcome')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'expectedOutcome') BETWEEN 1 AND 4000
    AND "specialist_input_revisions"."objective_input"->>'expectedOutcome' ~ '[^[:space:]]'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'input')='string'
    AND char_length("specialist_input_revisions"."objective_input"->>'input')<=8000
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'targetIds')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'inputRefs')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'constraints')='array'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'expectedResult')='object'
    AND jsonb_typeof("specialist_input_revisions"."objective_input"->'verification')='array'
    AND pg_column_size("specialist_input_revisions"."objective_input")<=262144
    AND jsonb_typeof("specialist_input_revisions"."standing_definition")='object' AND "specialist_input_revisions"."standing_definition"->'schemaVersion' IN ('1'::jsonb,'2'::jsonb)
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'definition')='object'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'agentId')='string'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'packageInstallId')='string'
    AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'packageRevision')='string'
    AND "specialist_input_revisions"."standing_definition"->>'definitionSha256' ~ '^[a-f0-9]{64}$'
    AND (CASE WHEN "specialist_input_revisions"."standing_definition"->'schemaVersion'='2'::jsonb THEN
      jsonb_typeof("specialist_input_revisions"."standing_definition"->'coordinatorFlow')='object'
      AND "specialist_input_revisions"."standing_definition"->'coordinatorFlow' ?& ARRAY['flowId','flowRefId','flowRevisionId','resolvedRevision','manifestSha256']
      AND ("specialist_input_revisions"."standing_definition"->'coordinatorFlow')-ARRAY['flowId','flowRefId','flowRevisionId','resolvedRevision','manifestSha256']='{}'::jsonb
      AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->'flowId')='string'
      AND char_length("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'flowId') BETWEEN 1 AND 128
      AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->'flowRefId')='string'
      AND char_length("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'flowRefId') BETWEEN 1 AND 128
      AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->'flowRevisionId')='string'
      AND char_length("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'flowRevisionId') BETWEEN 1 AND 128
      AND jsonb_typeof("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->'resolvedRevision')='string'
      AND char_length("specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'resolvedRevision') BETWEEN 1 AND 192
      AND "specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'manifestSha256' ~ '^[a-f0-9]{64}$'
      AND "specialist_input_revisions"."standing_definition"->'coordinatorFlow'->>'flowRefId'="specialist_input_revisions"."standing_definition"->'definition'->>'flow'
      ELSE true END)
    AND pg_column_size("specialist_input_revisions"."standing_definition")<=2097152
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot")='object' AND "specialist_input_revisions"."authority_snapshot"->'schemaVersion'='1'::jsonb
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'actor')='object'
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'witnesses')='array'
    AND jsonb_typeof("specialist_input_revisions"."authority_snapshot"->'executionPolicy')='object'
    AND pg_column_size("specialist_input_revisions"."authority_snapshot")<=262144
    AND jsonb_typeof("specialist_input_revisions"."source_restrictions")='array' AND pg_column_size("specialist_input_revisions"."source_restrictions")<=131072
  ) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_specialist_project_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.project_task_id IS NOT NULL AND NEW.project_task_id IS DISTINCT FROM OLD.project_task_id THEN
    RAISE EXCEPTION 'The original project assignment task is immutable; continuations retain separate existing work/run links'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_project_task_immutable';
  END IF;
  IF NEW.project_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks task WHERE task.id=NEW.project_task_id AND task.project_id=NEW.project_id AND NEW.company_id IS NULL FOR SHARE
  ) THEN
    RAISE EXCEPTION 'The initial assignment task must belong to its explicit project owner'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_project_task_reference';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_assignments_project_task_guard
BEFORE INSERT OR UPDATE ON specialist_assignments
FOR EACH ROW EXECUTE FUNCTION guard_specialist_project_task();
