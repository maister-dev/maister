CREATE FUNCTION validate_task_qualification_v1(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; dimensions text[] := ARRAY[]::text[]; evidence_ids text[] := ARRAY[]::text[];
BEGIN
  IF NOT (jsonb_typeof(v)='object' AND v ?& ARRAY['schemaVersion','requestType','decision','checks','reasonCodes','nextActions','evidenceRefs'] AND v->'schemaVersion'='1'::jsonb AND v->>'requestType' IN ('bug','feature','maintenance','question') AND v->>'decision' IN ('ready','needs_information','needs_review','not_actionable') AND jsonb_typeof(v->'checks')='array' AND jsonb_array_length(v->'checks')=7 AND jsonb_typeof(v->'reasonCodes')='array' AND jsonb_array_length(v->'reasonCodes')<=16 AND jsonb_typeof(v->'nextActions')='array' AND jsonb_array_length(v->'nextActions')<=16 AND jsonb_typeof(v->'evidenceRefs')='array' AND jsonb_array_length(v->'evidenceRefs')<=32) IS TRUE THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v)) <> 7 THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(v->'evidenceRefs') LOOP
    IF NOT (jsonb_typeof(c)='object' AND c ?& ARRAY['id','kind','reference'] AND c->>'kind' IN ('repository','task','run','source','human_attestation') AND length(c->>'id') BETWEEN 1 AND 256 AND length(c->>'reference') BETWEEN 1 AND 256) IS TRUE THEN RETURN false; END IF;
    IF c->>'id'=ANY(evidence_ids) THEN RETURN false; END IF;
    evidence_ids := array_append(evidence_ids,c->>'id');
  END LOOP;
  FOR c IN SELECT value FROM jsonb_array_elements(v->'checks') LOOP
    IF NOT (jsonb_typeof(c)='object' AND c ?& ARRAY['dimension','state','rationale','evidenceIds'] AND c->>'dimension' IN ('goal_scope','acceptance','consistency','constraints_dependencies','duplicates','relevance','bug_evidence') AND c->>'state' IN ('pass','fail','unknown','not_applicable') AND length(c->>'rationale') BETWEEN 1 AND 2000 AND jsonb_typeof(c->'evidenceIds')='array' AND jsonb_array_length(c->'evidenceIds')<=32) IS TRUE THEN RETURN false; END IF;
    IF c->>'dimension'=ANY(dimensions) THEN RETURN false; END IF;
    dimensions := array_append(dimensions,c->>'dimension');
    IF c->>'state'='not_applicable' AND (c->>'dimension'<>'bug_evidence' OR v->>'requestType'='bug') THEN RETURN false; END IF;
    IF v->>'decision'='ready' AND c->>'state' NOT IN ('pass','not_applicable') THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'evidenceIds') e(id) WHERE NOT e.id=ANY(evidence_ids)) THEN RETURN false; END IF;
  END LOOP;
  IF v->>'decision'<>'ready' AND (jsonb_array_length(v->'reasonCodes')=0 OR jsonb_array_length(v->'nextActions')=0) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'reasonCodes') r(code) WHERE r.code !~ '^[a-z][a-z0-9_]{0,255}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'nextActions') a(value) WHERE length(a.value) NOT BETWEEN 1 AND 2000) THEN RETURN false; END IF;
  IF v->>'decision'='ready' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'checks') check_entry(value), jsonb_array_elements(v->'evidenceRefs') reference_entry(value)
    WHERE check_entry.value->>'dimension'='relevance' AND reference_entry.value->>'kind'='repository' AND check_entry.value->'evidenceIds' @> jsonb_build_array(reference_entry.value->>'id')
  ) THEN RETURN false; END IF;
  IF v->>'decision'='not_actionable' AND jsonb_array_length(v->'evidenceRefs')=0 THEN RETURN false; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE TABLE "task_qualifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"input_revision" integer NOT NULL,
	"input_digest" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"expected_qualification_revision" integer,
	"author_kind" text NOT NULL,
	"author_identity" text NOT NULL,
	"author_token_id" text,
	"author_user_id" text,
	"author_run_id" text,
	"original_run_id" text,
	"evidence_target" text NOT NULL,
	"evidence_sha" text,
	"value" jsonb NOT NULL,
	"routing" jsonb NOT NULL,
	"publication_state" text NOT NULL,
	"publication_reason" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_qualification_revision_uq" UNIQUE("task_id","revision"),
	CONSTRAINT "task_qualification_request_uq" UNIQUE("task_id","input_revision","request_key"),
	CONSTRAINT "task_qualification_shape_check" CHECK (("task_qualifications"."policy_version" = 1 AND "task_qualifications"."input_revision" >= 1 AND "task_qualifications"."revision" >= 1 AND "task_qualifications"."input_digest" ~ '^[a-f0-9]{64}$' AND "task_qualifications"."payload_digest" ~ '^[a-f0-9]{64}$' AND (("task_qualifications"."evidence_sha" IS NULL AND "task_qualifications"."value"->>'decision' <> 'ready') OR "task_qualifications"."evidence_sha" ~ '^[a-f0-9]{40}([a-f0-9]{24})?$') AND "task_qualifications"."author_kind" IN ('user','project_token','agent_run') AND ("task_qualifications"."author_kind" <> 'agent_run' OR "task_qualifications"."original_run_id" IS NOT NULL AND "task_qualifications"."author_token_id" IS NOT NULL) AND ("task_qualifications"."author_run_id" IS NULL OR "task_qualifications"."author_run_id" = "task_qualifications"."original_run_id") AND pg_column_size("task_qualifications"."value") <= 131072 AND validate_task_qualification_v1("task_qualifications"."value") AND (("task_qualifications"."publication_state" = 'candidate' AND "task_qualifications"."published_at" IS NULL AND "task_qualifications"."publication_reason" IS NULL AND "task_qualifications"."author_kind" = 'agent_run') OR ("task_qualifications"."publication_state" = 'accepted' AND "task_qualifications"."published_at" IS NOT NULL AND "task_qualifications"."publication_reason" IS NULL) OR ("task_qualifications"."publication_state" = 'rejected' AND "task_qualifications"."published_at" IS NOT NULL AND length("task_qualifications"."publication_reason") BETWEEN 1 AND 256))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_qualification_baseline" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_qualification_override" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_qualification_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_admission_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "qualification_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "qualification_input_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "qualification_revision_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_qualification_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_qualification_revision" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "qualification_child_proof" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "qualification_source_version" text;--> statement-breakpoint
ALTER TABLE "task_qualifications" ADD CONSTRAINT "task_qualifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_qualifications" ADD CONSTRAINT "task_qualifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_qualifications" ADD CONSTRAINT "task_qualifications_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_qualifications" ADD CONSTRAINT "task_qualifications_author_run_id_runs_id_fk" FOREIGN KEY ("author_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_qualification_run_input_uq" ON "task_qualifications" USING btree ("task_id","original_run_id","input_revision") WHERE "task_qualifications"."original_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_qualification_history_idx" ON "task_qualifications" USING btree ("project_id","task_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_qualification_candidate_idx" ON "task_qualifications" USING btree ("original_run_id","task_id") WHERE "task_qualifications"."publication_state" = 'candidate';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_qualification_id_task_qualifications_id_fk" FOREIGN KEY ("current_qualification_id") REFERENCES "public"."task_qualifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_qualification_partition_idx" ON "tasks" USING btree ("project_id","qualification_mode","current_qualification_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_qualification_policy_check" CHECK ("projects"."task_qualification_baseline" IN ('legacy','required') AND ("projects"."task_qualification_override" IS NULL OR "projects"."task_qualification_override" IN ('legacy','required')));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_qualification_snapshot_check" CHECK ("runs"."task_qualification_snapshot" IS NULL OR ("runs"."run_kind" = 'agent' AND "runs"."agent_kind" = 'operational' AND jsonb_typeof("runs"."task_qualification_snapshot") = 'object' AND "runs"."task_qualification_snapshot"->'version' = '1'::jsonb AND "runs"."task_qualification_snapshot"->>'role' IN ('intake','qualifier') AND ("runs"."task_qualification_snapshot"->>'role' <> 'qualifier' OR "runs"."agent_workspace" = 'repo_read' AND "runs"."task_qualification_snapshot"->>'taskId' = "runs"."task_id" AND length("runs"."task_qualification_snapshot"->>'target') BETWEEN 1 AND 255 AND "runs"."task_qualification_snapshot"->>'sha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$')) IS TRUE);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_admission_snapshot_check" CHECK ("runs"."task_admission_snapshot" IS NULL OR ("runs"."task_id" IS NOT NULL AND jsonb_typeof("runs"."task_admission_snapshot") = 'object' AND "runs"."task_admission_snapshot"->'version' = '1'::jsonb AND "runs"."task_admission_snapshot"->>'mode' IN ('legacy','required','execution_child') AND "runs"."task_admission_snapshot"->'policyVersion' = '1'::jsonb AND jsonb_typeof("runs"."task_admission_snapshot"->'inputRevision') = 'number' AND ("runs"."task_admission_snapshot"->>'mode' <> 'required' OR jsonb_typeof("runs"."task_admission_snapshot"->'qualificationId') = 'string' AND jsonb_typeof("runs"."task_admission_snapshot"->'qualificationRevision') = 'number' AND "runs"."task_admission_snapshot"->>'evidenceSha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$') AND ("runs"."task_admission_snapshot"->>'mode' <> 'execution_child' OR jsonb_typeof("runs"."task_admission_snapshot"->'parent') = 'object')) IS TRUE);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_qualification_shape_check" CHECK (("tasks"."qualification_mode" IN ('legacy','required','execution_child') AND "tasks"."qualification_input_revision" >= 1 AND "tasks"."qualification_revision_counter" >= 0 AND (("tasks"."current_qualification_id" IS NULL AND "tasks"."current_qualification_revision" IS NULL) OR ("tasks"."current_qualification_id" IS NOT NULL AND "tasks"."current_qualification_revision" >= 1 AND "tasks"."current_qualification_revision" <= "tasks"."qualification_revision_counter")) AND (("tasks"."qualification_mode" = 'execution_child' AND jsonb_typeof("tasks"."qualification_child_proof") = 'object' AND "tasks"."qualification_child_proof"->'version' = '1'::jsonb) OR ("tasks"."qualification_mode" <> 'execution_child' AND "tasks"."qualification_child_proof" IS NULL))) IS TRUE);--> statement-breakpoint
CREATE FUNCTION task_qualification_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy text; project_base text; semantic_change boolean;
BEGIN
  SELECT coalesce(task_qualification_override,task_qualification_baseline),main_branch INTO policy,project_base FROM projects WHERE id=NEW.project_id;
  IF TG_OP='INSERT' THEN
    IF NEW.qualification_mode <> 'execution_child' AND policy='required' THEN NEW.qualification_mode:='required'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.qualification_mode='required' AND NEW.qualification_mode='legacy' THEN
    RAISE EXCEPTION 'required task qualification cannot be waived' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_required_monotonic';
  END IF;
  IF NEW.qualification_revision_counter < OLD.qualification_revision_counter THEN
    RAISE EXCEPTION 'qualification revision counter cannot decrease' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_counter_monotonic';
  END IF;
  semantic_change := ROW(NEW.title,NEW.prompt,NEW.statement_revision,NEW.qualification_source_version,coalesce(NEW.base_branch,project_base),coalesce(NEW.target_branch,project_base)) IS DISTINCT FROM ROW(OLD.title,OLD.prompt,OLD.statement_revision,OLD.qualification_source_version,coalesce(OLD.base_branch,project_base),coalesce(OLD.target_branch,project_base));
  IF semantic_change OR NEW.qualification_input_revision > OLD.qualification_input_revision THEN
    NEW.qualification_input_revision:=OLD.qualification_input_revision+1;
    NEW.current_qualification_id:=NULL; NEW.current_qualification_revision:=NULL;
    IF OLD.qualification_mode='execution_child' THEN NEW.qualification_mode:='required'; NEW.qualification_child_proof:=NULL; END IF;
    IF NEW.qualification_mode<>'legacy' THEN NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL; NEW.queue_claimed_at:=NULL; END IF;
  ELSIF NEW.qualification_input_revision<>OLD.qualification_input_revision THEN
    RAISE EXCEPTION 'qualification input revision cannot decrease' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_input_monotonic';
  END IF;
  IF OLD.qualification_mode<>NEW.qualification_mode AND NEW.qualification_mode='required' THEN
    NEW.current_qualification_id:=NULL; NEW.current_qualification_revision:=NULL;
    NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL; NEW.queue_claimed_at:=NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_qualification_input_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION task_qualification_input_guard();
--> statement-breakpoint
CREATE FUNCTION task_qualification_invalidation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.qualification_mode<>'legacy' OR OLD.qualification_mode<>'legacy') AND (NEW.qualification_input_revision IS DISTINCT FROM OLD.qualification_input_revision OR NEW.current_qualification_id IS DISTINCT FROM OLD.current_qualification_id) THEN
    INSERT INTO domain_events(kind,project_id,task_id,actor_type,occurred_at,payload) VALUES ('task.qualification_changed',NEW.project_id,NEW.id,'system',now(),jsonb_build_object('projectId',NEW.project_id,'taskId',NEW.id,'inputRevision',NEW.qualification_input_revision,'qualificationRevision',NEW.current_qualification_revision));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_qualification_invalidation_event AFTER UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION task_qualification_invalidation_event();
--> statement-breakpoint
CREATE FUNCTION invalidate_qualification_clarification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT NEW.blocking THEN RETURN NEW; END IF;
  ELSIF ROW(NEW.blocking,NEW.status,NEW.answer,NEW.answered_at,NEW.superseded_at) IS NOT DISTINCT FROM ROW(OLD.blocking,OLD.status,OLD.answer,OLD.answered_at,OLD.superseded_at) OR NOT (NEW.blocking OR OLD.blocking) THEN RETURN NEW;
  END IF;
  UPDATE tasks SET qualification_input_revision=qualification_input_revision+1 WHERE id=NEW.task_id AND qualification_mode<>'legacy';
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_clarifications_qualification_input AFTER INSERT OR UPDATE ON task_clarifications FOR EACH ROW EXECUTE FUNCTION invalidate_qualification_clarification();
--> statement-breakpoint
CREATE FUNCTION guard_task_qualification_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['publication_state','publication_reason','published_at','author_user_id','author_run_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['publication_state','publication_reason','published_at','author_user_id','author_run_id']) OR (NEW.author_user_id IS DISTINCT FROM OLD.author_user_id AND NEW.author_user_id IS NOT NULL) OR (NEW.author_run_id IS DISTINCT FROM OLD.author_run_id AND NEW.author_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'task qualification assessment is immutable' USING ERRCODE='23514',CONSTRAINT='task_qualification_content_immutable';
  END IF;
  IF ROW(NEW.publication_state,NEW.publication_reason,NEW.published_at) IS DISTINCT FROM ROW(OLD.publication_state,OLD.publication_reason,OLD.published_at) AND (OLD.publication_state<>'candidate' OR NEW.publication_state NOT IN ('accepted','rejected')) THEN
    RAISE EXCEPTION 'task qualification publication is write-once' USING ERRCODE='23514',CONSTRAINT='task_qualification_publication_once';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_qualification_content_guard BEFORE UPDATE ON task_qualifications FOR EACH ROW EXECUTE FUNCTION guard_task_qualification_content();
--> statement-breakpoint
CREATE FUNCTION validate_task_qualification_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_task tasks%ROWTYPE; assessment task_qualifications%ROWTYPE; source runs%ROWTYPE; result_value jsonb;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN SELECT * INTO owner_task FROM tasks WHERE id=NEW.id;
  ELSE SELECT * INTO owner_task FROM tasks WHERE id=NEW.task_id; END IF;
  IF NOT FOUND OR owner_task.current_qualification_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO assessment FROM task_qualifications WHERE id=owner_task.current_qualification_id;
  IF NOT FOUND OR assessment.task_id<>owner_task.id OR assessment.project_id<>owner_task.project_id OR assessment.input_revision<>owner_task.qualification_input_revision OR assessment.revision<>owner_task.current_qualification_revision OR assessment.publication_state<>'accepted' THEN
    RAISE EXCEPTION 'current task qualification must be a matching accepted assessment' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_pointer_scope';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tasks_qualification_pointer AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_task_qualification_pointer();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER task_qualifications_pointer AFTER INSERT OR UPDATE ON task_qualifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_task_qualification_pointer();
--> statement-breakpoint
CREATE FUNCTION guard_task_admission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot OR OLD.task_qualification_snapshot IS DISTINCT FROM NEW.task_qualification_snapshot THEN RAISE EXCEPTION 'task admission snapshot is immutable' USING ERRCODE='23514',CONSTRAINT='runs_task_admission_immutable'; END IF;
  IF OLD.task_qualification_snapshot IS NOT NULL AND ROW(NEW.project_id,NEW.task_id,NEW.source_agent_id) IS DISTINCT FROM ROW(OLD.project_id,OLD.task_id,OLD.source_agent_id) THEN RAISE EXCEPTION 'qualifier run provenance is immutable' USING ERRCODE='23514',CONSTRAINT='runs_qualification_provenance_immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_admission_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_task_admission_snapshot();
--> statement-breakpoint
CREATE FUNCTION retain_active_qualification_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM task_qualifications q JOIN tasks t ON t.current_qualification_id=q.id WHERE q.original_run_id=OLD.id) THEN
    RAISE EXCEPTION 'run is retained as current task qualification evidence' USING ERRCODE='23514',CONSTRAINT='task_qualification_active_evidence_retained';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_retain_active_qualification BEFORE DELETE ON runs FOR EACH ROW EXECUTE FUNCTION retain_active_qualification_source();
--> statement-breakpoint
CREATE FUNCTION project_qualification_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_qualification_baseline IS DISTINCT FROM OLD.task_qualification_baseline THEN RAISE EXCEPTION 'project qualification creation baseline is immutable' USING ERRCODE='23514',CONSTRAINT='projects_qualification_baseline_immutable'; END IF;
  IF NEW.task_qualification_override IS DISTINCT FROM OLD.task_qualification_override THEN
    IF EXISTS(SELECT 1 FROM project_config_persist_operations WHERE project_id=OLD.id AND state IN ('preparing','prepared','publishing','recovery_required')) THEN RAISE EXCEPTION 'configuration publication requires completion before changing qualification policy' USING ERRCODE='55P03'; END IF;
    NEW.config_export_revision:=GREATEST(NEW.config_export_revision,OLD.config_export_revision+1);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_qualification_policy_guard BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION project_qualification_policy_guard();
--> statement-breakpoint
CREATE FUNCTION invalidate_project_qualification_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.main_branch IS DISTINCT FROM OLD.main_branch THEN UPDATE tasks SET qualification_input_revision=qualification_input_revision+1 WHERE project_id=NEW.id AND qualification_mode<>'legacy' AND (base_branch IS NULL OR target_branch IS NULL); END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER projects_qualification_target AFTER UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION invalidate_project_qualification_target();
--> statement-breakpoint
CREATE FUNCTION validate_task_qualification_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment task_qualifications%ROWTYPE; owner_task tasks%ROWTYPE; source runs%ROWTYPE; result_value jsonb;
BEGIN
  SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO owner_task FROM tasks WHERE id=assessment.task_id;
  IF NOT FOUND OR owner_task.project_id<>assessment.project_id OR assessment.revision>owner_task.qualification_revision_counter THEN
    RAISE EXCEPTION 'qualification assessment must belong to its task and allocated revision' USING ERRCODE='23514',CONSTRAINT='task_qualification_assessment_scope';
  END IF;
  IF assessment.author_kind='agent_run' AND assessment.publication_state<>'rejected' THEN
    SELECT * INTO source FROM runs WHERE id=assessment.author_run_id;
    IF NOT FOUND OR source.project_id<>assessment.project_id OR source.task_id<>assessment.task_id OR source.agent_kind IS DISTINCT FROM 'operational' OR source.task_qualification_snapshot->>'role' IS DISTINCT FROM 'qualifier' OR source.task_qualification_snapshot->>'target' IS DISTINCT FROM assessment.evidence_target OR source.task_qualification_snapshot->>'sha' IS DISTINCT FROM assessment.evidence_sha OR coalesce(source.source_agent_id,source.agent_id) IS DISTINCT FROM assessment.author_identity OR NOT (source.result_contract->'definition'->'taskQualification'->>'role'='qualifier') IS TRUE THEN
      RAISE EXCEPTION 'qualification requires its bound declared qualifier run' USING ERRCODE='23514',CONSTRAINT='task_qualification_author_scope';
    END IF;
    IF assessment.publication_state='accepted' THEN
      IF NOT (source.operational_terminal->'successful'='true'::jsonb AND source.operational_terminal->>'validation'='valid' AND source.operational_terminal->>'integrity'='clean') IS TRUE THEN
        RAISE EXCEPTION 'agent qualification requires clean validated terminal evidence' USING ERRCODE='23514',CONSTRAINT='task_qualification_source_evidence';
      END IF;
      SELECT value INTO result_value FROM run_results WHERE run_id=source.id AND revision::text=source.operational_terminal->>'resultRevision';
      IF NOT (result_value->'references' @> jsonb_build_array(jsonb_build_object('kind','other','id',assessment.id,'state','confirmed'))) IS TRUE THEN
        RAISE EXCEPTION 'operational result must reference its qualification receipt' USING ERRCODE='23514',CONSTRAINT='task_qualification_source_reference';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER task_qualifications_publication AFTER INSERT OR UPDATE ON task_qualifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_task_qualification_publication();
