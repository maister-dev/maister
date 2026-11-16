CREATE TABLE "specialist_work" (
	"id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"work_revision" integer NOT NULL,
	"assignment_id" text NOT NULL,
	"input_revision" integer NOT NULL,
	"input_sha256" text NOT NULL,
	"logical_work_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"decision_state" text DEFAULT 'open' NOT NULL,
	"parent_run_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"actor" jsonb NOT NULL,
	"authority_snapshot" jsonb NOT NULL,
	"bounds" jsonb NOT NULL,
	"source_restrictions" jsonb NOT NULL,
	"request_sha256" text NOT NULL,
	"source_key" text NOT NULL,
	"reserved_run_id" text NOT NULL,
	"child_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_work_id_work_revision_pk" PRIMARY KEY("id","work_revision"),
	CONSTRAINT "specialist_work_logical_revision_uq" UNIQUE("assignment_id","logical_work_id","work_revision"),
	CONSTRAINT "specialist_work_source_uq" UNIQUE("source_key"),
	CONSTRAINT "specialist_work_reserved_run_uq" UNIQUE("reserved_run_id"),
	CONSTRAINT "specialist_work_shape_check" CHECK ((
      char_length("specialist_work"."id") BETWEEN 1 AND 128 AND "specialist_work"."work_revision">0 AND "specialist_work"."input_revision">0 AND "specialist_work"."revision">0
      AND char_length("specialist_work"."logical_work_id") BETWEEN 1 AND 128 AND "specialist_work"."logical_work_id" ~ '^[A-Za-z0-9._:-]+$'
      AND "specialist_work"."decision_state" IN ('open','clarification_requested','accepted','rework_requested','cancelled')
      AND "specialist_work"."input_sha256" ~ '^[a-f0-9]{64}$' AND "specialist_work"."definition_sha256" ~ '^[a-f0-9]{64}$'
      AND "specialist_work"."request_sha256" ~ '^[a-f0-9]{64}$' AND "specialist_work"."source_key" ~ '^[a-f0-9]{64}$'
      AND char_length("specialist_work"."reserved_run_id") BETWEEN 1 AND 128 AND "specialist_work"."reserved_run_id"<>"specialist_work"."parent_run_id"
      AND ("specialist_work"."child_run_id" IS NULL OR "specialist_work"."child_run_id"="specialist_work"."reserved_run_id")
    ) IS TRUE),
	CONSTRAINT "specialist_work_actor_check" CHECK (((CASE WHEN jsonb_typeof("specialist_work"."actor")='object' THEN
    "specialist_work"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_work"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_work"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_work"."actor"->'id')='string'
    AND char_length("specialist_work"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_work"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_work"."actor"->'runId')='string' AND char_length("specialist_work"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_work"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_work"."actor"->'attemptId')='string' AND char_length("specialist_work"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND "specialist_work"."actor"->>'kind'='agent' AND "specialist_work"."actor"->>'runId'="specialist_work"."parent_run_id") IS TRUE),
	CONSTRAINT "specialist_work_definition_check" CHECK ((
      jsonb_typeof("specialist_work"."definition")='object' AND "specialist_work"."definition"->'schemaVersion'='1'::jsonb
      AND "specialist_work"."definition" ?& ARRAY['schemaVersion','objectiveInput','target','context','parent']
      AND "specialist_work"."definition"-ARRAY['schemaVersion','objectiveInput','target','context','parent']='{}'::jsonb
      AND jsonb_typeof("specialist_work"."definition"->'objectiveInput')='object' AND jsonb_typeof("specialist_work"."definition"->'target')='object'
      AND "specialist_work"."definition"->'target'->>'kind' IN ('project_agent','project_flow','company_agent','company_flow')
      AND jsonb_typeof("specialist_work"."definition"->'context')='object' AND jsonb_typeof("specialist_work"."definition"->'parent')='object'
      AND "specialist_work"."definition"->'parent'->>'runId'="specialist_work"."parent_run_id"
      AND "specialist_work"."definition"->'parent'->'nodeAttemptId'="specialist_work"."actor"->'attemptId'
      AND octet_length("specialist_work"."definition"::text)<=131072
    ) IS TRUE),
	CONSTRAINT "specialist_work_authority_check" CHECK ((
      jsonb_typeof("specialist_work"."authority_snapshot")='object' AND "specialist_work"."authority_snapshot"->'schemaVersion'='1'::jsonb
      AND "specialist_work"."authority_snapshot"->'actor'="specialist_work"."actor" AND jsonb_typeof("specialist_work"."authority_snapshot"->'witnesses')='array'
      AND jsonb_typeof("specialist_work"."authority_snapshot"->'executionPolicy')='object'
      AND jsonb_typeof("specialist_work"."authority_snapshot"->'capturedAt')='string' AND octet_length("specialist_work"."authority_snapshot"::text)<=32768
      AND jsonb_typeof("specialist_work"."source_restrictions")='array' AND octet_length("specialist_work"."source_restrictions"::text)<=65536
    ) IS TRUE),
	CONSTRAINT "specialist_work_bounds_check" CHECK ((
      jsonb_typeof("specialist_work"."bounds")='object' AND "specialist_work"."bounds"->'schemaVersion'='1'::jsonb
      AND "specialist_work"."bounds" ?& ARRAY['schemaVersion','maxDepth','maxFanout','maxActiveChildren','maxChildRuns','maxTokens','wallClockMinutes','consecutiveFailures']
      AND "specialist_work"."bounds"-ARRAY['schemaVersion','maxDepth','maxFanout','maxActiveChildren','maxChildRuns','maxTokens','wallClockMinutes','consecutiveFailures']='{}'::jsonb
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'maxDepth')='number' THEN ("specialist_work"."bounds"->>'maxDepth')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'maxDepth')::numeric)=("specialist_work"."bounds"->>'maxDepth')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'maxFanout')='number' THEN ("specialist_work"."bounds"->>'maxFanout')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'maxFanout')::numeric)=("specialist_work"."bounds"->>'maxFanout')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'maxActiveChildren')='number' THEN ("specialist_work"."bounds"->>'maxActiveChildren')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'maxActiveChildren')::numeric)=("specialist_work"."bounds"->>'maxActiveChildren')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'maxChildRuns')='number' THEN ("specialist_work"."bounds"->>'maxChildRuns')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'maxChildRuns')::numeric)=("specialist_work"."bounds"->>'maxChildRuns')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'maxTokens')='number' THEN ("specialist_work"."bounds"->>'maxTokens')::numeric BETWEEN 1 AND 9007199254740991 AND trunc(("specialist_work"."bounds"->>'maxTokens')::numeric)=("specialist_work"."bounds"->>'maxTokens')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'wallClockMinutes')='number' THEN ("specialist_work"."bounds"->>'wallClockMinutes')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'wallClockMinutes')::numeric)=("specialist_work"."bounds"->>'wallClockMinutes')::numeric ELSE false END
      AND CASE WHEN jsonb_typeof("specialist_work"."bounds"->'consecutiveFailures')='number' THEN ("specialist_work"."bounds"->>'consecutiveFailures')::numeric BETWEEN 1 AND 2147483647 AND trunc(("specialist_work"."bounds"->>'consecutiveFailures')::numeric)=("specialist_work"."bounds"->>'consecutiveFailures')::numeric ELSE false END
      AND octet_length("specialist_work"."bounds"::text)<=8192
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" DROP CONSTRAINT "specialist_intake_receipts_shape_check";--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" ADD COLUMN "work_id" text;--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" ADD COLUMN "work_revision" integer;--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD COLUMN "work_witness" jsonb;--> statement-breakpoint
ALTER TABLE "specialist_work" ADD CONSTRAINT "specialist_work_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_work" ADD CONSTRAINT "specialist_work_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_work" ADD CONSTRAINT "specialist_work_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_work_child_run_uq" ON "specialist_work" USING btree ("child_run_id") WHERE "specialist_work"."child_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "specialist_work_assignment_idx" ON "specialist_work" USING btree ("assignment_id","created_at","id","work_revision");--> statement-breakpoint
CREATE INDEX "specialist_work_parent_idx" ON "specialist_work" USING btree ("parent_run_id","id","work_revision");--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" ADD CONSTRAINT "specialist_intake_receipts_work_fk" FOREIGN KEY ("work_id","work_revision") REFERENCES "public"."specialist_work"("id","work_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" ADD CONSTRAINT "specialist_intake_receipts_shape_check" CHECK (("specialist_intake_receipts"."source_kind" IN ('manual','task_comment','schedule','event','webhook','delegation') AND "specialist_intake_receipts"."source_key" ~ '^[a-f0-9]{64}$' AND "specialist_intake_receipts"."request_digest" ~ '^[a-f0-9]{64}$' AND (("specialist_intake_receipts"."disposition"='created' AND "specialist_intake_receipts"."work_id" IS NULL AND "specialist_intake_receipts"."work_revision" IS NULL) OR ("specialist_intake_receipts"."disposition"='delegated' AND "specialist_intake_receipts"."source_kind"='delegation' AND "specialist_intake_receipts"."work_id" IS NOT NULL AND "specialist_intake_receipts"."work_revision">0)) AND "specialist_intake_receipts"."input_revision">0 AND char_length("specialist_intake_receipts"."assignment_id") BETWEEN 1 AND 128) IS TRUE);--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD CONSTRAINT "specialist_run_links_work_witness_check" CHECK (("specialist_run_links"."work_witness" IS NULL OR (
      jsonb_typeof("specialist_run_links"."work_witness")='object' AND "specialist_run_links"."work_witness"->'schemaVersion'='1'::jsonb
      AND "specialist_run_links"."work_witness"-ARRAY['schemaVersion','id','workRevision','definitionSha256']='{}'::jsonb
      AND "specialist_run_links"."work_witness"->>'id'="specialist_run_links"."work_id" AND "specialist_run_links"."work_witness"->'workRevision'=to_jsonb("specialist_run_links"."work_revision")
      AND "specialist_run_links"."work_witness"->>'definitionSha256' ~ '^[a-f0-9]{64}$'
      AND "specialist_run_links"."role" IN ('child','continuation') AND octet_length("specialist_run_links"."work_witness"::text)<=1024
    )) IS TRUE);
--> statement-breakpoint
-- Main-store references only. Current source access and action authority remain service decisions.
CREATE FUNCTION specialist_work_target_exists(target jsonb, company_owner text, project_owner text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE target->>'kind'
    WHEN 'project_agent' THEN project_owner IS NOT NULL AND company_owner IS NULL AND target->>'projectId'=project_owner AND EXISTS (
      SELECT 1 FROM agent_project_links link JOIN agents role ON role.id=link.agent_id
      JOIN package_installs pin ON pin.id=target->'role'->>'packageInstallId' AND pin.name=role.package_name
      JOIN project_package_attachments attachment ON attachment.project_id=link.project_id AND attachment.package_install_id=pin.id
      WHERE link.id=target->>'attachmentId' AND link.project_id=project_owner AND link.enabled
        AND link.agent_id=target->'role'->>'agentId' AND pin.resolved_revision=target->'role'->>'packageRevision'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    )
    WHEN 'project_flow' THEN project_owner IS NOT NULL AND company_owner IS NULL AND target->>'projectId'=project_owner AND EXISTS (
      SELECT 1 FROM flows flow JOIN flow_revisions revision ON revision.flow_ref_id=flow.flow_ref_id
      WHERE flow.id=target->>'flowId' AND flow.project_id=project_owner
        AND revision.id=target->'flow'->>'flowRevisionId' AND revision.flow_ref_id=target->'flow'->>'flowRefId'
        AND revision.resolved_revision=target->'flow'->>'resolvedRevision' AND revision.manifest_digest=target->'flow'->>'manifestSha256'
    )
    WHEN 'company_agent' THEN company_owner IS NOT NULL AND project_owner IS NULL AND target->>'companyId'=company_owner AND EXISTS (
      SELECT 1 FROM company_specialist_bindings binding JOIN company_specialist_binding_revisions history
        ON history.binding_id=binding.id AND history.revision=binding.revision
      JOIN package_installs pin ON pin.id=binding.package_install_id
      WHERE binding.id=target->'specialistBinding'->>'id' AND binding.company_id=company_owner AND binding.enabled AND binding.detached_at IS NULL
        AND binding.revision::text=target->'specialistBinding'->>'revision' AND history.snapshot_digest=target->'specialistBinding'->>'snapshotSha256'
        AND history.snapshot->>'agentId'=target->'role'->>'agentId' AND history.snapshot->>'packageInstallId'=target->'role'->>'packageInstallId'
        AND history.snapshot->>'packageRevision'=target->'role'->>'packageRevision' AND history.snapshot->>'definitionSha256'=target->'role'->>'definitionSha256'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    )
    WHEN 'company_flow' THEN company_owner IS NOT NULL AND project_owner IS NULL AND target->>'companyId'=company_owner AND EXISTS (
      SELECT 1 FROM company_flow_bindings flow JOIN company_flow_binding_revisions history ON history.binding_id=flow.id AND history.revision=flow.revision
      JOIN company_specialist_bindings binding ON binding.id=flow.specialist_binding_id AND binding.company_id=flow.company_id
      JOIN company_specialist_binding_revisions role ON role.binding_id=binding.id AND role.revision=binding.revision
      JOIN flow_revisions revision ON revision.id=flow.flow_revision_id
      JOIN package_installs pin ON pin.id=flow.package_install_id
      WHERE flow.id=target->'coordinatorBinding'->>'id' AND flow.company_id=company_owner AND flow.enabled AND flow.detached_at IS NULL
        AND flow.revision::text=target->'coordinatorBinding'->>'revision' AND history.snapshot_digest=target->'coordinatorBinding'->>'snapshotSha256'
        AND binding.id=target->'specialistBinding'->>'id' AND binding.enabled AND binding.detached_at IS NULL
        AND binding.revision::text=target->'specialistBinding'->>'revision' AND role.snapshot_digest=target->'specialistBinding'->>'snapshotSha256'
        AND role.snapshot->>'agentId'=target->'role'->>'agentId' AND role.snapshot->>'packageInstallId'=target->'role'->>'packageInstallId'
        AND role.snapshot->>'packageRevision'=target->'role'->>'packageRevision' AND role.snapshot->>'definitionSha256'=target->'role'->>'definitionSha256'
        AND revision.id=target->'flow'->>'flowRevisionId' AND revision.flow_ref_id=target->'flow'->>'flowRefId'
        AND revision.resolved_revision=target->'flow'->>'resolvedRevision' AND revision.manifest_digest=target->'flow'->>'manifestSha256'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    ) ELSE false END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION specialist_run_has_input(source_run text, subject_assignment text, requested_revision integer, requested_digest text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE retained(revision,digest,depth) AS (
    SELECT input.revision,input.digest,0 FROM specialist_run_links link
    JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id AND input.revision=link.input_revision
    WHERE link.run_id=source_run AND link.assignment_id=subject_assignment AND (
      (link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL AND link.work_witness IS NULL)
      OR (link.role IN ('child','continuation') AND EXISTS (
        SELECT 1 FROM specialist_work work WHERE work.id=link.work_id AND work.work_revision=link.work_revision
          AND work.assignment_id=link.assignment_id AND work.input_revision=link.input_revision AND work.child_run_id=link.run_id
          AND link.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
      ))
    )
    UNION ALL
    SELECT next_input.revision,next_input.digest,retained.depth+1 FROM retained
    JOIN hitl_requests question ON question.run_id=source_run AND question.specialist_assignment_id=subject_assignment
      AND question.specialist_input_revision=retained.revision AND question.kind='agent_question'
      AND question.activation_state='active' AND question.responded_at IS NOT NULL AND question.response IS NOT NULL
      AND question.superseded_at IS NULL AND question.specialist_answer IS NOT NULL
    JOIN specialist_input_revisions next_input ON next_input.assignment_id=subject_assignment AND next_input.revision=question.specialist_answer_input_revision
      AND next_input.digest=question.specialist_answer->>'inputSha256'
    WHERE retained.depth<32 AND next_input.revision>retained.revision
  ) SELECT EXISTS(SELECT 1 FROM retained WHERE revision=requested_revision AND digest=requested_digest)
$$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject specialist_assignments%ROWTYPE;
  source runs%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Logical work and its immutable definitions must be retained'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_retained';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.work_revision,NEW.assignment_id,NEW.input_revision,NEW.input_sha256,NEW.logical_work_id,NEW.parent_run_id,
      NEW.definition,NEW.definition_sha256,NEW.actor,NEW.authority_snapshot,NEW.bounds,NEW.source_restrictions,NEW.request_sha256,NEW.source_key,NEW.reserved_run_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.work_revision,OLD.assignment_id,OLD.input_revision,OLD.input_sha256,OLD.logical_work_id,OLD.parent_run_id,
      OLD.definition,OLD.definition_sha256,OLD.actor,OLD.authority_snapshot,OLD.bounds,OLD.source_restrictions,OLD.request_sha256,OLD.source_key,OLD.reserved_run_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Logical work definition and original attribution are immutable'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_definition_immutable';
    END IF;
    IF NEW.revision::bigint<>OLD.revision::bigint+1 THEN
      RAISE EXCEPTION 'Logical work requires the next business revision'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_business_revision';
    END IF;
    IF NEW.decision_state NOT IN ('open','cancelled') OR OLD.decision_state='cancelled'
      OR (NEW.child_run_id IS NOT DISTINCT FROM OLD.child_run_id AND NEW.decision_state IS NOT DISTINCT FROM OLD.decision_state) THEN
      RAISE EXCEPTION 'A logical work decision requires its exact decision-owning contract'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_required';
    END IF;
    IF OLD.child_run_id IS NOT NULL AND NEW.child_run_id IS DISTINCT FROM OLD.child_run_id THEN
      RAISE EXCEPTION 'An executed child cannot be detached or rebound'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_immutable';
    END IF;
    IF NEW.decision_state='cancelled' AND NEW.child_run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM runs child WHERE child.id=NEW.child_run_id AND child.status NOT IN ('Done','Failed','Crashed','Abandoned')
    ) THEN
      RAISE EXCEPTION 'Stop and observe the owned child before cancelling logical work'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_live';
    END IF;
  ELSE
    IF NEW.work_revision<>1 OR NEW.revision<>1 OR NEW.decision_state<>'open' OR NEW.child_run_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM specialist_work work WHERE work.id=NEW.id OR (work.assignment_id=NEW.assignment_id AND work.logical_work_id=NEW.logical_work_id)) THEN
      RAISE EXCEPTION 'A new logical work subject requires its initial request and business revisions; rework requires an owned decision'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_revision_unavailable';
    END IF;
    SELECT * INTO subject FROM specialist_assignments WHERE id=NEW.assignment_id;
    SELECT * INTO source FROM runs WHERE id=NEW.parent_run_id;
    IF subject.id IS NULL OR source.id IS NULL OR subject.input_revision<>NEW.input_revision
      OR subject.status NOT IN ('active','waiting_children') OR source.status<>'Running'
      OR source.project_id IS DISTINCT FROM subject.project_id OR source.company_id IS DISTINCT FROM subject.company_id
      OR source.knowledge_access->>'state' IS DISTINCT FROM 'complete'
      OR NOT specialist_run_has_input(source.id,subject.id,NEW.input_revision,NEW.input_sha256)
      OR NEW.definition->'parent'->>'rootRunId' IS DISTINCT FROM coalesce(source.root_run_id,source.id)
      OR NOT (
        (source.run_kind='agent' AND source.agent_id=NEW.actor->>'id' AND NEW.actor->'attemptId'='null'::jsonb)
        OR (source.run_kind='flow' AND EXISTS (
          SELECT 1 FROM node_attempts node WHERE node.id=NEW.actor->>'attemptId' AND node.run_id=source.id AND node.node_id=source.current_step_id
            AND node.status='Running' AND node.knowledge_actor->>'agentId'=NEW.actor->>'id'
            AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=node.run_id AND newer.node_id=node.node_id AND newer.attempt>node.attempt)
        ))
      ) THEN
      RAISE EXCEPTION 'Logical work requires its exact active attributed assignment execution and input'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_source_binding';
    END IF;
    IF subject.context_revision::text IS DISTINCT FROM NEW.definition->'context'->>'revision' OR NOT (
      (subject.context_revision=0 AND NEW.definition->'context'->'contentSha256'='null'::jsonb
        AND NEW.definition->'context'->>'inputRevision'=NEW.input_revision::text AND NEW.definition->'context'->>'inputSha256'=NEW.input_sha256)
      OR (subject.context_revision>0 AND EXISTS (
        SELECT 1 FROM specialist_context_revisions context JOIN specialist_input_revisions input
          ON input.assignment_id=context.assignment_id AND input.revision=context.input_revision
        WHERE context.assignment_id=subject.id AND context.revision=subject.context_revision
          AND context.content_digest=NEW.definition->'context'->>'contentSha256'
          AND context.input_revision::text=NEW.definition->'context'->>'inputRevision' AND input.digest=NEW.definition->'context'->>'inputSha256'
      ))
    ) THEN
      RAISE EXCEPTION 'Logical work must retain the exact available context witness without inventing history'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_context_binding';
    END IF;
    IF EXISTS(SELECT 1 FROM runs WHERE id=NEW.reserved_run_id) THEN
      RAISE EXCEPTION 'A new work reservation cannot claim an existing execution'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_reservation_unused';
    END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.child_run_id IS DISTINCT FROM OLD.child_run_id THEN
    SELECT * INTO subject FROM specialist_assignments WHERE id=NEW.assignment_id;
    IF NOT specialist_work_target_exists(NEW.definition->'target',subject.company_id,subject.project_id) THEN
      RAISE EXCEPTION 'Logical work target must match its current owned installed binding and available version witness'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_target_binding';
    END IF;
  END IF;
  IF NEW.child_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs child JOIN specialist_assignments assignment ON assignment.id=NEW.assignment_id
    WHERE child.id=NEW.child_run_id AND child.id=NEW.reserved_run_id AND child.parent_run_id=NEW.parent_run_id
      AND child.root_run_id=NEW.definition->'parent'->>'rootRunId'
      AND child.project_id IS NOT DISTINCT FROM assignment.project_id AND child.company_id IS NOT DISTINCT FROM assignment.company_id
      AND CASE NEW.definition->'target'->>'kind'
        WHEN 'project_agent' THEN child.run_kind='agent' AND child.agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'agentId'=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'packageInstallId'=NEW.definition->'target'->'role'->>'packageInstallId'
          AND child.agent_activity_snapshot->>'packageRevision'=NEW.definition->'target'->'role'->>'packageRevision'
          AND child.agent_activity_snapshot->>'definitionSha256'=NEW.definition->'target'->'role'->>'definitionSha256'
        WHEN 'company_agent' THEN child.run_kind='agent' AND child.source_agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'agentId'=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'packageInstallId'=NEW.definition->'target'->'role'->>'packageInstallId'
          AND child.agent_activity_snapshot->>'packageRevision'=NEW.definition->'target'->'role'->>'packageRevision'
          AND child.agent_activity_snapshot->>'definitionSha256'=NEW.definition->'target'->'role'->>'definitionSha256'
        WHEN 'project_flow' THEN child.run_kind='flow' AND child.flow_id=NEW.definition->'target'->>'flowId'
          AND child.flow_revision_id=NEW.definition->'target'->'flow'->>'flowRevisionId'
        WHEN 'company_flow' THEN child.run_kind='flow' AND child.source_agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.flow_revision_id=NEW.definition->'target'->'flow'->>'flowRevisionId'
        ELSE false END
  ) THEN
    RAISE EXCEPTION 'Logical work can bind only its same-owner reserved direct child'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_child_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_work_guard BEFORE INSERT OR UPDATE OR DELETE ON specialist_work
FOR EACH ROW EXECUTE FUNCTION guard_specialist_work();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Specialist intake receipts are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_intake_receipts_immutable';
  END IF;
  IF (NEW.disposition='created' AND NOT EXISTS (
    SELECT 1 FROM specialist_assignments assignment JOIN specialist_input_revisions input
      ON input.assignment_id=assignment.id AND input.revision=NEW.input_revision
    WHERE assignment.id=NEW.assignment_id AND assignment.origin->>'kind'=NEW.source_kind AND input.actor=NEW.actor
  )) OR (NEW.disposition='delegated' AND NOT EXISTS (
    SELECT 1 FROM specialist_work work WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision
      AND work.assignment_id=NEW.assignment_id AND work.input_revision=NEW.input_revision AND work.actor=NEW.actor
      AND work.source_key=NEW.source_key AND work.request_sha256=NEW.request_digest AND NEW.source_kind='delegation'
  )) THEN
    RAISE EXCEPTION 'Specialist intake receipt must identify its exact source and server-attributed input or work'
      USING ERRCODE='23514',CONSTRAINT='specialist_intake_receipts_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_work_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.work_witness IS DISTINCT FROM OLD.work_witness THEN
    RAISE EXCEPTION 'A historical work label cannot acquire native appointment authority'
      USING ERRCODE='23514',CONSTRAINT='specialist_run_links_work_witness_immutable';
  END IF;
  IF NEW.work_witness IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_work work JOIN runs child ON child.id=NEW.run_id
    WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.assignment_id=NEW.assignment_id AND work.input_revision=NEW.input_revision
      AND work.reserved_run_id=NEW.run_id AND (work.child_run_id IS NULL OR work.child_run_id=NEW.run_id)
      AND child.parent_run_id=work.parent_run_id AND NEW.role IN ('child','continuation')
      AND NEW.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
  ) THEN
    RAISE EXCEPTION 'Native child appointment must name its exact retained work and reserved execution'
      USING ERRCODE='23514',CONSTRAINT='specialist_run_links_work_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_run_links_work_guard BEFORE INSERT OR UPDATE ON specialist_run_links
FOR EACH ROW EXECUTE FUNCTION guard_specialist_work_link();
--> statement-breakpoint
CREATE FUNCTION check_specialist_work_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  work specialist_work%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='specialist_work' THEN
    SELECT * INTO work FROM specialist_work WHERE id=NEW.id AND work_revision=NEW.work_revision;
  ELSE
    IF NEW.work_witness IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO work FROM specialist_work WHERE id=NEW.work_id AND work_revision=NEW.work_revision;
  END IF;
  IF work.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM specialist_intake_receipts receipt WHERE receipt.work_id=work.id AND receipt.work_revision=work.work_revision
      AND receipt.assignment_id=work.assignment_id AND receipt.input_revision=work.input_revision AND receipt.disposition='delegated'
      AND receipt.source_kind='delegation' AND receipt.source_key=work.source_key AND receipt.request_digest=work.request_sha256 AND receipt.actor=work.actor
  ) THEN
    RAISE EXCEPTION 'Logical work must commit with its exact canonical delegated intake receipt'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_intake_required';
  END IF;
  IF TG_TABLE_NAME='specialist_run_links' THEN
    IF work.child_run_id IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'Native child appointment must commit with its exact bound work execution'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_appointment_required';
    END IF;
  END IF;
  IF work.child_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_run_links link WHERE link.run_id=work.child_run_id AND link.assignment_id=work.assignment_id
      AND link.input_revision=work.input_revision AND link.work_id=work.id AND link.work_revision=work.work_revision AND link.role IN ('child','continuation')
      AND link.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
  ) THEN
    RAISE EXCEPTION 'Executed logical work must commit with its exact native child appointment'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_child_appointment_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_work_enrollment_check AFTER INSERT OR UPDATE ON specialist_work
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_specialist_work_enrollment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_work_link_enrollment_check AFTER INSERT ON specialist_run_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_specialist_work_enrollment();
