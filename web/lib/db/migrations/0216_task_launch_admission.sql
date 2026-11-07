CREATE TABLE "task_launch_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"actor_user_id" text,
	"launch_source" text NOT NULL,
	"operation" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"task_revision" integer NOT NULL,
	"input_revision" integer NOT NULL,
	"input_digest" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"settings_digest" text NOT NULL,
	"settings_snapshot" jsonb NOT NULL,
	"basis" jsonb NOT NULL,
	"reservation_lane" text DEFAULT 'ordinary' NOT NULL,
	"replaces_intent_id" text,
	"source_run_id" text,
	"run_id" text,
	"original_run_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"reason" text,
	"terminal_outcome" text,
	"dispatch_committed_at" timestamp with time zone,
	"cancellation_receipt" jsonb,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_launch_intents_request_key_uq" UNIQUE("principal_kind","principal_id","project_id","operation","request_key"),
	CONSTRAINT "task_launch_intents_run_binding_uq" UNIQUE("original_run_id"),
	CONSTRAINT "task_launch_intents_replace_uq" UNIQUE("replaces_intent_id"),
	CONSTRAINT "task_launch_intents_state_check" CHECK ("task_launch_intents"."state" in ('queued', 'preparing', 'run_bound', 'held', 'cancelled', 'failed', 'settled')),
	CONSTRAINT "task_launch_intents_cancellation_check" CHECK ("task_launch_intents"."cancellation_receipt" IS NULL OR ("task_launch_intents"."state"='cancelled' AND jsonb_typeof("task_launch_intents"."cancellation_receipt")='object' AND "task_launch_intents"."cancellation_receipt"->'version'='1'::jsonb AND "task_launch_intents"."cancellation_receipt"->>'principalKind' IN ('session_user','project_token','agent','system') AND length("task_launch_intents"."cancellation_receipt"->>'principalId') BETWEEN 1 AND 256 AND length("task_launch_intents"."cancellation_receipt"->>'requestKey') BETWEEN 1 AND 256 AND "task_launch_intents"."cancellation_receipt"->>'payloadDigest' ~ '^[0-9a-f]{64}$' AND jsonb_typeof("task_launch_intents"."cancellation_receipt"->'expectedStateVersion')='number' AND ("task_launch_intents"."cancellation_receipt"->>'expectedStateVersion')::numeric>0 AND ("task_launch_intents"."cancellation_receipt"->>'expectedStateVersion')::numeric=trunc(("task_launch_intents"."cancellation_receipt"->>'expectedStateVersion')::numeric) AND jsonb_typeof("task_launch_intents"."cancellation_receipt"->'cancelledAt')='string' AND "task_launch_intents"."cancellation_receipt"->>'cancelledAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND "task_launch_intents"."cancellation_receipt"->'actorUserId' IS NOT NULL AND octet_length("task_launch_intents"."cancellation_receipt"::text)<=8192 AND "task_launch_intents"."cancellation_receipt"-ARRAY['version','principalKind','principalId','actorUserId','requestKey','payloadDigest','expectedStateVersion','cancelledAt']='{}'::jsonb) IS TRUE),
	CONSTRAINT "task_launch_intents_shape_check" CHECK (("task_launch_intents"."schema_version"=1 AND "task_launch_intents"."task_revision">=0 AND "task_launch_intents"."input_revision">0 AND "task_launch_intents"."state_version">0 AND "task_launch_intents"."attempts" BETWEEN 0 AND 3 AND length("task_launch_intents"."request_key") BETWEEN 1 AND 256 AND length("task_launch_intents"."principal_id") BETWEEN 1 AND 256 AND "task_launch_intents"."payload_digest" ~ '^[0-9a-f]{64}$' AND "task_launch_intents"."input_digest" ~ '^[0-9a-f]{64}$' AND "task_launch_intents"."settings_digest" ~ '^[0-9a-f]{64}$' AND "task_launch_intents"."principal_kind" IN ('session_user','project_token','agent','system') AND "task_launch_intents"."launch_source" IN ('web','api','mcp','scheduler','retry','execution_child','recovery') AND "task_launch_intents"."operation" IN ('launch','retry','replace') AND "task_launch_intents"."reservation_lane" IN ('ordinary','concurrent') AND ("task_launch_intents"."reason" IS NULL OR length("task_launch_intents"."reason") BETWEEN 1 AND 256) AND (("task_launch_intents"."state"='preparing')=("task_launch_intents"."lease_token" IS NOT NULL AND "task_launch_intents"."lease_expires_at" IS NOT NULL)) AND (("task_launch_intents"."lease_token" IS NULL)=("task_launch_intents"."lease_expires_at" IS NULL)) AND ("task_launch_intents"."state"<>'queued' OR "task_launch_intents"."due_at" IS NOT NULL) AND ("task_launch_intents"."state" NOT IN ('held','failed') OR "task_launch_intents"."reason" IS NOT NULL) AND ("task_launch_intents"."state"<>'run_bound' OR "task_launch_intents"."run_id" IS NOT NULL AND "task_launch_intents"."original_run_id"="task_launch_intents"."run_id") AND ("task_launch_intents"."run_id" IS NULL OR "task_launch_intents"."original_run_id"="task_launch_intents"."run_id") AND (("task_launch_intents"."state"='settled')=("task_launch_intents"."terminal_outcome" IS NOT NULL)) AND ("task_launch_intents"."terminal_outcome" IS NULL OR "task_launch_intents"."terminal_outcome" IN ('Done','Failed','Crashed','Abandoned'))) IS TRUE),
	CONSTRAINT "task_launch_intents_snapshot_check" CHECK ((jsonb_typeof("task_launch_intents"."input_snapshot")='object' AND "task_launch_intents"."input_snapshot"->'version'='1'::jsonb AND "task_launch_intents"."input_snapshot"->>'projectId'="task_launch_intents"."project_id" AND "task_launch_intents"."input_snapshot"->>'taskId'="task_launch_intents"."task_id" AND jsonb_typeof("task_launch_intents"."input_snapshot"->'title')='string' AND jsonb_typeof("task_launch_intents"."input_snapshot"->'prompt')='string' AND jsonb_typeof("task_launch_intents"."input_snapshot"->'clarifications')='array' AND jsonb_array_length("task_launch_intents"."input_snapshot"->'clarifications')<=1000 AND octet_length("task_launch_intents"."input_snapshot"::text)<=262144 AND jsonb_typeof("task_launch_intents"."settings_snapshot")='object' AND "task_launch_intents"."settings_snapshot"->'version'='1'::jsonb AND ("task_launch_intents"."settings_snapshot"->>'kind'='flow' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'flowId')='string' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'flowRevisionId')='string' AND "task_launch_intents"."settings_snapshot"->'agentId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'definitionSha256'='null'::jsonb OR "task_launch_intents"."settings_snapshot"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->'flowId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'flowRefId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'flowRevisionId'='null'::jsonb AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'agentId')='string' AND "task_launch_intents"."settings_snapshot"->>'definitionSha256' ~ '^[0-9a-f]{64}$') AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'sessions')='array' AND jsonb_array_length("task_launch_intents"."settings_snapshot"->'sessions') BETWEEN 1 AND 64 AND ("task_launch_intents"."settings_snapshot"->>'baseCommit' ~ '^[0-9a-f]{40,64}$' OR "task_launch_intents"."settings_snapshot"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->>'workspace'='none' AND "task_launch_intents"."settings_snapshot"->'baseCommit'='null'::jsonb) AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'autoPromote')='boolean' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'executionPolicy')='object' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'deliveryPolicy')='object' AND octet_length("task_launch_intents"."settings_snapshot"::text)<=131072 AND jsonb_typeof("task_launch_intents"."basis")='object' AND "task_launch_intents"."basis"->>'kind' IN ('manual','automatic','execution_child') AND ("task_launch_intents"."basis"->>'kind'<>'manual' OR "task_launch_intents"."principal_kind"='session_user' AND "task_launch_intents"."actor_user_id"="task_launch_intents"."principal_id" AND "task_launch_intents"."basis"->>'userId'="task_launch_intents"."actor_user_id") AND ("task_launch_intents"."basis"->>'kind'<>'automatic' OR jsonb_typeof("task_launch_intents"."basis"->'qualificationId')='string' AND jsonb_typeof("task_launch_intents"."basis"->'qualificationRevision')='number' AND "task_launch_intents"."basis"->>'qualificationInputDigest' ~ '^[0-9a-f]{64}$' AND "task_launch_intents"."basis"->>'evidenceSha' ~ '^[0-9a-f]{40,64}$') AND ("task_launch_intents"."basis"->>'kind'<>'execution_child' OR jsonb_typeof("task_launch_intents"."basis"->'parent')='object')) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_task_admission_snapshot_check";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_launch_intent_id" text;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_replaces_intent_id_task_launch_intents_id_fk" FOREIGN KEY ("replaces_intent_id") REFERENCES "public"."task_launch_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_launch_intents_cancel_key_uq" ON "task_launch_intents" USING btree ("project_id",("cancellation_receipt"->>'principalKind'),("cancellation_receipt"->>'principalId'),("cancellation_receipt"->>'requestKey')) WHERE "task_launch_intents"."cancellation_receipt" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_launch_intents_active_task_uq" ON "task_launch_intents" USING btree ("task_id") WHERE "task_launch_intents"."reservation_lane"='ordinary' AND "task_launch_intents"."state" IN ('queued','preparing','run_bound','held');--> statement-breakpoint
CREATE INDEX "task_launch_intents_recovery_idx" ON "task_launch_intents" USING btree ("state","due_at","id");--> statement-breakpoint
CREATE INDEX "task_launch_intents_history_idx" ON "task_launch_intents" USING btree ("project_id","task_id","accepted_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_launch_intent_id_task_launch_intents_id_fk" FOREIGN KEY ("task_launch_intent_id") REFERENCES "public"."task_launch_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_launch_intent_uq" UNIQUE("task_launch_intent_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_admission_snapshot_check" CHECK ("runs"."task_admission_snapshot" IS NULL OR ("runs"."task_id" IS NOT NULL AND jsonb_typeof("runs"."task_admission_snapshot")='object' AND jsonb_typeof("runs"."task_admission_snapshot"->'inputRevision')='number' AND ("runs"."task_admission_snapshot"->>'mode'<>'required' OR jsonb_typeof("runs"."task_admission_snapshot"->'qualificationId')='string' AND jsonb_typeof("runs"."task_admission_snapshot"->'qualificationRevision')='number' AND "runs"."task_admission_snapshot"->>'evidenceSha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$') AND ("runs"."task_admission_snapshot"->>'mode'<>'execution_child' OR jsonb_typeof("runs"."task_admission_snapshot"->'parent')='object') AND (("runs"."task_launch_intent_id" IS NULL AND "runs"."task_admission_snapshot"->'version'='1'::jsonb AND "runs"."task_admission_snapshot"->'policyVersion'='1'::jsonb AND "runs"."task_admission_snapshot"->>'mode' IN ('legacy','required','execution_child')) OR ("runs"."task_launch_intent_id" IS NOT NULL AND "runs"."task_admission_snapshot"->'version'='2'::jsonb AND "runs"."task_admission_snapshot"->'policyVersion'='2'::jsonb AND "runs"."task_admission_snapshot"->>'intentId'="runs"."task_launch_intent_id" AND "runs"."task_admission_snapshot"->>'mode' IN ('manual','required','execution_child') AND "runs"."task_admission_snapshot"->>'basis'=CASE "runs"."task_admission_snapshot"->>'mode' WHEN 'manual' THEN 'manual' WHEN 'required' THEN 'automatic' ELSE 'execution_child' END AND "runs"."task_admission_snapshot"-ARRAY['version','policyVersion','mode','inputRevision','qualificationId','qualificationRevision','evidenceTarget','evidenceSha','parent','intentId','basis']='{}'::jsonb AND ("runs"."task_admission_snapshot"->>'mode'<>'manual' OR "runs"."task_admission_snapshot"->'qualificationId'='null'::jsonb AND "runs"."task_admission_snapshot"->'qualificationRevision'='null'::jsonb AND "runs"."task_admission_snapshot"->'parent'='null'::jsonb AND ("runs"."task_admission_snapshot"->>'evidenceSha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$' OR "runs"."run_kind"='agent' AND "runs"."agent_workspace"='none' AND "runs"."task_admission_snapshot"->'evidenceSha'='null'::jsonb))))) IS TRUE);--> statement-breakpoint
CREATE FUNCTION guard_task_launch_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE; assessment task_qualifications%ROWTYPE; slot jsonb; seen_slots text[]:=ARRAY[]::text[];
BEGIN
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'Task launch writer v1 required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.cancellation_receipt IS NOT NULL AND OLD.cancellation_receipt IS DISTINCT FROM NEW.cancellation_receipt
      OR OLD.cancellation_receipt IS NULL AND NEW.cancellation_receipt IS NOT NULL AND NOT (
        OLD.state<>'cancelled' AND NEW.state='cancelled' AND NEW.cancellation_receipt->'expectedStateVersion'=to_jsonb(OLD.state_version)
      ) IS TRUE THEN
      RAISE EXCEPTION 'Cancellation receipt is immutable and must bind the accepted state version'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_cancellation_immutable';
    END IF;
    IF NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
      OR NEW.attempts>OLD.attempts AND NOT (OLD.state='preparing' AND NEW.state IN ('queued','held','failed')) THEN
      RAISE EXCEPTION 'Preparation failure budget is monotonic and scoped to this launch'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_attempts_fenced';
    END IF;
    IF OLD.state='preparing' AND OLD.lease_expires_at<=clock_timestamp()
      AND NEW.state NOT IN ('held','cancelled') AND NOT (NEW.state='preparing' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
      RAISE EXCEPTION 'Expired launch worker must reacquire ownership before publication'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_lease_fenced';
    END IF;
    IF OLD.run_id IS NOT NULL AND NEW.run_id IS NULL AND OLD.state IN ('settled','cancelled','failed')
      AND ROW(NEW.state,NEW.reason,NEW.original_run_id,NEW.attempts,NEW.terminal_outcome,NEW.dispatch_committed_at)
        IS NOT DISTINCT FROM ROW(OLD.state,OLD.reason,OLD.original_run_id,OLD.attempts,OLD.terminal_outcome,OLD.dispatch_committed_at) THEN
      NEW.state_version:=OLD.state_version+1;
      NEW.updated_at:=clock_timestamp();
    END IF;
    IF ROW(OLD.id,OLD.schema_version,OLD.project_id,OLD.task_id,OLD.principal_kind,OLD.principal_id,OLD.actor_user_id,
        OLD.launch_source,OLD.operation,OLD.request_key,OLD.payload_digest,OLD.task_revision,OLD.input_revision,
        OLD.input_digest,OLD.input_snapshot,OLD.settings_digest,OLD.settings_snapshot,OLD.basis,OLD.reservation_lane,
        OLD.replaces_intent_id,OLD.source_run_id,OLD.accepted_at)
      IS DISTINCT FROM ROW(NEW.id,NEW.schema_version,NEW.project_id,NEW.task_id,NEW.principal_kind,NEW.principal_id,NEW.actor_user_id,
        NEW.launch_source,NEW.operation,NEW.request_key,NEW.payload_digest,NEW.task_revision,NEW.input_revision,
        NEW.input_digest,NEW.input_snapshot,NEW.settings_digest,NEW.settings_snapshot,NEW.basis,NEW.reservation_lane,
        NEW.replaces_intent_id,NEW.source_run_id,NEW.accepted_at)
      OR OLD.original_run_id IS NOT NULL AND OLD.original_run_id IS DISTINCT FROM NEW.original_run_id
      OR OLD.dispatch_committed_at IS NOT NULL AND OLD.dispatch_committed_at IS DISTINCT FROM NEW.dispatch_committed_at THEN
      RAISE EXCEPTION 'Accepted task launch request is immutable'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_request_immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      OLD.state='queued' AND NEW.state IN ('preparing','held','cancelled') OR
      OLD.state='preparing' AND NEW.state IN ('queued','run_bound','held','cancelled','failed') OR
      OLD.state='held' AND NEW.state IN ('queued','cancelled') OR
      OLD.state='run_bound' AND NEW.state IN ('held','cancelled','settled') OR
      OLD.state='settled' AND NEW.state='run_bound' AND OLD.terminal_outcome='Crashed' AND NEW.run_id=OLD.run_id
    ) THEN
      RAISE EXCEPTION 'Task launch state transition is not allowed'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_transition_check';
    END IF;
    IF OLD.dispatch_committed_at IS NOT NULL AND NEW.state IN ('held','cancelled') THEN
      RAISE EXCEPTION 'Execution already committed; use Stop for this run'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_dispatch_committed';
    END IF;
    IF ROW(NEW.state,NEW.reason,NEW.run_id,NEW.original_run_id,NEW.attempts,NEW.terminal_outcome,NEW.dispatch_committed_at)
      IS DISTINCT FROM ROW(OLD.state,OLD.reason,OLD.run_id,OLD.original_run_id,OLD.attempts,OLD.terminal_outcome,OLD.dispatch_committed_at) THEN
      IF NEW.state_version<>OLD.state_version+1 THEN
        RAISE EXCEPTION 'Task launch transition requires the next state version'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_state_version';
      END IF;
    ELSIF NEW.state_version<>OLD.state_version THEN
      RAISE EXCEPTION 'Lease renewal cannot invent a task launch transition'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_state_version';
    END IF;
  ELSE
    IF NOT (
      NEW.input_snapshot ?& ARRAY['version','projectId','taskId','number','title','prompt','statementRevision','sourceVersion','target','deliveryTarget','clarifications']
      AND NEW.settings_snapshot ?& ARRAY['version','kind','workspace','agentId','definitionSha256','flowId','flowRefId','flowRevisionId','packageInstallId','sessions','baseBranch','baseCommit','targetBranch','promotionMode','autoPromote','deliveryPolicy','executionPolicy','taskSettingsDigest','resolutionToken']
      AND jsonb_typeof(NEW.input_snapshot->'number')='number' AND (NEW.input_snapshot->>'number')::numeric>0
      AND jsonb_typeof(NEW.input_snapshot->'target')='string' AND length(NEW.input_snapshot->>'target') BETWEEN 1 AND 256
      AND jsonb_typeof(NEW.input_snapshot->'deliveryTarget')='string' AND length(NEW.input_snapshot->>'deliveryTarget') BETWEEN 1 AND 256
      AND (NEW.settings_snapshot->>'kind'='flow' AND NEW.settings_snapshot->>'workspace'='worktree' AND length(NEW.settings_snapshot->>'flowId') BETWEEN 1 AND 256
        AND length(NEW.settings_snapshot->>'flowRefId') BETWEEN 1 AND 256
        AND length(NEW.settings_snapshot->>'flowRevisionId') BETWEEN 1 AND 256
        OR NEW.settings_snapshot->>'kind'='agent' AND NEW.settings_snapshot->>'workspace' IN ('none','repo_read','worktree') AND length(NEW.settings_snapshot->>'agentId') BETWEEN 1 AND 256
        AND NEW.settings_snapshot->>'definitionSha256' ~ '^[0-9a-f]{64}$')
      AND length(NEW.settings_snapshot->>'baseBranch') BETWEEN 1 AND 256
      AND length(NEW.settings_snapshot->>'targetBranch') BETWEEN 1 AND 256
      AND NEW.settings_snapshot->>'promotionMode' IN ('local_merge','rebase_merge','pull_request')
      AND NEW.settings_snapshot->>'taskSettingsDigest' ~ '^[0-9a-f]{64}$'
      AND NEW.settings_snapshot->>'resolutionToken' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(NEW.settings_snapshot->'sessions')='array'
    ) IS TRUE THEN
      RAISE EXCEPTION 'Task launch snapshots are incomplete or malformed'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_snapshot_check';
    END IF;
    FOR slot IN SELECT value FROM jsonb_array_elements(NEW.settings_snapshot->'sessions') LOOP
      IF NOT (jsonb_typeof(slot)='object' AND slot ?& ARRAY['sessionName','runnerId','runnerSnapshot','runnerConfigDigest']
        AND jsonb_typeof(slot->'sessionName')='string' AND length(slot->>'sessionName') BETWEEN 1 AND 256
        AND jsonb_typeof(slot->'runnerId')='string' AND length(slot->>'runnerId') BETWEEN 1 AND 256
        AND jsonb_typeof(slot->'runnerSnapshot')='object' AND slot->'runnerSnapshot'->>'id'=slot->>'runnerId'
        AND NOT slot->'runnerSnapshot' ?| ARRAY['env','provider']
        AND slot->>'runnerConfigDigest' ~ '^[0-9a-f]{64}$'
        AND NOT slot->>'sessionName'=ANY(seen_slots)) IS TRUE THEN
        RAISE EXCEPTION 'Task launch runner metadata must be unique, bounded and credential-free'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_snapshot_check';
      END IF;
      seen_slots:=array_append(seen_slots,slot->>'sessionName');
    END LOOP;
    SELECT * INTO target FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id FOR SHARE;
    IF NOT FOUND OR target.revision<>NEW.task_revision OR target.qualification_input_revision<>NEW.input_revision
      OR target.title IS DISTINCT FROM NEW.input_snapshot->>'title' OR target.prompt IS DISTINCT FROM NEW.input_snapshot->>'prompt' THEN
      RAISE EXCEPTION 'Task launch must freeze the current task input'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_input_current';
    END IF;
    IF NEW.state<>'queued' OR NEW.run_id IS NOT NULL OR NEW.original_run_id IS NOT NULL OR NEW.state_version<>1
      OR NEW.dispatch_committed_at IS NOT NULL OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'A new launch starts queued without execution authority'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_initial_state';
    END IF;
    IF NEW.basis->>'kind'='automatic' THEN
      SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.basis->>'qualificationId'
        AND project_id=NEW.project_id AND task_id=NEW.task_id;
      IF NOT FOUND OR assessment.publication_state<>'accepted' OR assessment.value->>'decision'<>'ready'
        OR assessment.input_revision<>target.qualification_input_revision OR assessment.input_digest IS DISTINCT FROM NEW.basis->>'qualificationInputDigest'
        OR assessment.id IS DISTINCT FROM target.current_qualification_id OR assessment.revision IS DISTINCT FROM target.current_qualification_revision
        OR to_jsonb(assessment.revision) IS DISTINCT FROM NEW.basis->'qualificationRevision'
        OR assessment.evidence_target IS DISTINCT FROM NEW.basis->>'evidenceTarget'
        OR assessment.evidence_sha IS DISTINCT FROM NEW.basis->>'evidenceSha'
        OR assessment.evidence_sha IS DISTINCT FROM NEW.settings_snapshot->>'baseCommit' THEN
        RAISE EXCEPTION 'Automatic task launch requires current accepted qualification'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_automatic_admission';
      END IF;
    END IF;
    IF NEW.basis->>'kind'='execution_child' AND NOT (
      target.qualification_mode='execution_child' AND target.qualification_child_proof=NEW.basis->'parent'
      AND EXISTS(SELECT 1 FROM runs parent WHERE parent.id=NEW.basis->'parent'->>'parentRunId'
        AND parent.project_id=NEW.project_id AND parent.agent_kind IS DISTINCT FROM 'operational'
        AND parent.status IN ('Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren','Review')
        AND parent.task_id IS NOT DISTINCT FROM NEW.basis->'parent'->>'parentTaskId')
    ) IS TRUE THEN
      RAISE EXCEPTION 'Execution child launch requires its live admitted parent proof'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_parent_admission';
    END IF;
  END IF;
  IF NEW.state='preparing' AND NOT (length(NEW.lease_token) BETWEEN 1 AND 256
      AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=clock_timestamp()+interval '61 seconds') IS TRUE THEN
    RAISE EXCEPTION 'Preparing launch requires a bounded current owner lease'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_lease_required';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND task_id=NEW.task_id
      AND project_id=NEW.project_id AND task_launch_intent_id=NEW.id) THEN
    RAISE EXCEPTION 'Task launch run binding does not match its request'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_run_binding';
  END IF;
  IF NEW.state='settled' AND NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status=NEW.terminal_outcome)
      OR NEW.state='cancelled' AND NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status='Abandoned') THEN
    RAISE EXCEPTION 'Bound launch settlement requires its terminal run transition'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_terminal_binding';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_launch_intents_guard BEFORE INSERT OR UPDATE ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_intent();
--> statement-breakpoint
CREATE FUNCTION guard_task_launch_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('queued','preparing','run_bound','held') THEN
    RAISE EXCEPTION 'Active launch authority must be cancelled or settled before retention'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_active_retention';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_launch_intents_retention BEFORE DELETE ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_retention();
--> statement-breakpoint
CREATE FUNCTION guard_run_task_launch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.task_launch_intent_id IS DISTINCT FROM NEW.task_launch_intent_id THEN
    RAISE EXCEPTION 'Run launch authority is write-once'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_immutable';
  END IF;
  IF NEW.task_launch_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id FOR SHARE;
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v1' OR NOT FOUND
    OR intent.project_id IS DISTINCT FROM NEW.project_id OR intent.task_id IS DISTINCT FROM NEW.task_id
    OR intent.state<>'preparing' OR intent.lease_expires_at<=clock_timestamp()
    OR NEW.task_admission_snapshot->>'intentId' IS DISTINCT FROM intent.id
    OR NEW.task_admission_snapshot->>'basis' IS DISTINCT FROM intent.basis->>'kind'
    OR NEW.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(intent.input_revision)
    OR NEW.task_admission_snapshot->>'evidenceSha' IS DISTINCT FROM intent.settings_snapshot->>'baseCommit'
    OR NEW.task_admission_snapshot->>'evidenceTarget' IS DISTINCT FROM intent.settings_snapshot->>'baseBranch'
    OR intent.original_run_id IS NOT NULL AND intent.original_run_id<>NEW.id THEN
    RAISE EXCEPTION 'Run requires its claimed matching launch intent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_required';
  END IF;
  IF intent.basis->>'kind'='automatic' AND (
    NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM intent.basis->>'qualificationId'
    OR NEW.task_admission_snapshot->'qualificationRevision' IS DISTINCT FROM intent.basis->'qualificationRevision'
    OR NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND current_qualification_id=intent.basis->>'qualificationId'
      AND to_jsonb(current_qualification_revision)=intent.basis->'qualificationRevision' AND qualification_input_revision=intent.input_revision)
  ) OR intent.basis->>'kind'='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM intent.basis->'parent' THEN
    RAISE EXCEPTION 'Run admission differs from its accepted qualification or parent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_basis_required';
  END IF;
  IF NEW.run_kind IS DISTINCT FROM intent.settings_snapshot->>'kind'
    OR NEW.agent_kind='operational' OR NEW.execution_policy IS DISTINCT FROM intent.settings_snapshot->'executionPolicy'
    OR (NEW.run_kind='flow' AND (NEW.flow_id IS DISTINCT FROM intent.settings_snapshot->>'flowId'
      OR NEW.flow_revision_id IS DISTINCT FROM intent.settings_snapshot->>'flowRevisionId'))
    OR (NEW.run_kind='agent' AND (NEW.agent_workspace IS DISTINCT FROM intent.settings_snapshot->>'workspace' OR NEW.agent_id IS DISTINCT FROM intent.settings_snapshot->>'agentId'
      OR NEW.agent_activity_snapshot->>'definitionSha256' IS DISTINCT FROM intent.settings_snapshot->>'definitionSha256')) THEN
    RAISE EXCEPTION 'Run target and execution policy must match the frozen launch settings'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_settings_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_launch_binding BEFORE INSERT OR UPDATE OF task_launch_intent_id ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_run_task_launch_binding();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_new_task_delivery_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE;
BEGIN
  IF NEW.task_launch_intent_id IS NOT NULL THEN
    -- The intent binding guard validates stored basis, input, lease and scope.
    -- v1 remains byte-compatible until the coordinated v2 writer cutover.
    RETURN NEW;
  END IF;
  IF NEW.task_id IS NULL OR NEW.agent_kind='operational' THEN RETURN NEW; END IF;
  SELECT * INTO target FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id;
  IF NOT FOUND OR target.qualification_mode='legacy' THEN RETURN NEW; END IF;
  IF NEW.task_admission_snapshot IS NULL OR NEW.task_admission_snapshot->>'mode' IS DISTINCT FROM target.qualification_mode
    OR (NEW.task_admission_snapshot->>'inputRevision')::int<>target.qualification_input_revision
    OR (target.qualification_mode='required' AND (NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM target.current_qualification_id
      OR (NEW.task_admission_snapshot->>'qualificationRevision')::int IS DISTINCT FROM target.current_qualification_revision))
    OR (target.qualification_mode='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM target.qualification_child_proof) THEN
    RAISE EXCEPTION 'delivery admission must bind the current task qualification'
      USING ERRCODE='23514',CONSTRAINT='runs_task_delivery_admission_required';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION guard_task_launch_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE guarded boolean;
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    guarded:=NEW.task_launch_intent_id IS NOT NULL;
  ELSE
    SELECT EXISTS(SELECT 1 FROM task_launch_intents WHERE task_id=NEW.id AND state IN ('queued','preparing','run_bound','held')) INTO guarded;
  END IF;
  IF guarded AND current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'Task launch writer v1 required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_launch_writer BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_writer();
--> statement-breakpoint
CREATE TRIGGER tasks_task_launch_writer BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_writer();
