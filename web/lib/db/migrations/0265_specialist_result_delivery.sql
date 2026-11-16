CREATE TABLE "specialist_delivery_receipts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"assignment_id" text NOT NULL,
	"input_revision" integer NOT NULL,
	"run_id" text NOT NULL,
	"result_revision" integer NOT NULL,
	"signal" text NOT NULL,
	"source_event_id" text NOT NULL,
	"outbox_event_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_delivery_receipts_signal_uq" UNIQUE("assignment_id","run_id","result_revision","signal"),
	CONSTRAINT "specialist_delivery_receipts_outbox_uq" UNIQUE("outbox_event_id"),
	CONSTRAINT "specialist_delivery_receipts_shape_check" CHECK (("specialist_delivery_receipts"."signal"='result_available' AND "specialist_delivery_receipts"."input_revision">0 AND "specialist_delivery_receipts"."result_revision">0 AND "specialist_delivery_receipts"."source_event_id" ~ '^[1-9][0-9]{0,23}$' AND jsonb_typeof("specialist_delivery_receipts"."snapshot")='object' AND pg_column_size("specialist_delivery_receipts"."snapshot")<=131072 AND "specialist_delivery_receipts"."snapshot"->'schemaVersion'='1'::jsonb AND "specialist_delivery_receipts"."snapshot"->>'assignmentId'="specialist_delivery_receipts"."assignment_id" AND "specialist_delivery_receipts"."snapshot"->>'runId'="specialist_delivery_receipts"."run_id" AND "specialist_delivery_receipts"."snapshot"->'inputRevision'=to_jsonb("specialist_delivery_receipts"."input_revision") AND "specialist_delivery_receipts"."snapshot"->'resultRevision'=to_jsonb("specialist_delivery_receipts"."result_revision")) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "assignment_result" jsonb;--> statement-breakpoint
ALTER TABLE "specialist_delivery_receipts" ADD CONSTRAINT "specialist_delivery_receipts_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_delivery_receipts_assignment_idx" ON "specialist_delivery_receipts" USING btree ("assignment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "specialist_delivery_receipts_run_idx" ON "specialist_delivery_receipts" USING btree ("run_id","result_revision");--> statement-breakpoint
-- Capture at the canonical event write, before a delayed dispatcher can observe another result.
CREATE FUNCTION capture_specialist_result_witness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution runs%ROWTYPE; subject specialist_assignments%ROWTYPE; effective specialist_input_revisions%ROWTYPE; result run_results%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.assignment_result IS DISTINCT FROM OLD.assignment_result OR
      (OLD.assignment_result IS NOT NULL AND ROW(NEW.id,NEW.kind,NEW.company_id,NEW.project_id,NEW.run_id,NEW.occurred_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.company_id,OLD.project_id,OLD.run_id,OLD.occurred_at)) THEN
      RAISE EXCEPTION 'Native result event witnesses and routing are immutable'
        USING ERRCODE='23514',CONSTRAINT='specialist_result_event_immutable';
    END IF;
    RETURN NEW;
  END IF;
  NEW.assignment_result:=NULL;
  IF NEW.run_id IS NULL OR NEW.kind NOT IN ('run.done','run.review','run.review_opened') THEN RETURN NEW; END IF;
  SELECT * INTO execution FROM runs WHERE id=NEW.run_id FOR SHARE;
  IF NOT FOUND OR execution.knowledge_access->>'state' IS DISTINCT FROM 'complete'
    OR NOT ((NEW.kind='run.done' AND execution.status='Done') OR (NEW.kind IN ('run.review','run.review_opened') AND execution.status='Review')) THEN RETURN NEW; END IF;
  SELECT assignment.* INTO subject FROM specialist_run_links link
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id
    WHERE link.run_id=execution.id AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL;
  IF NOT FOUND OR subject.company_id IS DISTINCT FROM execution.company_id OR subject.project_id IS DISTINCT FROM execution.project_id
    OR subject.company_id IS DISTINCT FROM NEW.company_id OR subject.project_id IS DISTINCT FROM NEW.project_id
    OR subject.requester->>'kind' IS DISTINCT FROM 'user' THEN RETURN NEW; END IF;
  SELECT * INTO effective FROM specialist_input_revisions input
    WHERE input.assignment_id=subject.id AND specialist_run_has_input(execution.id,subject.id,input.revision,input.digest)
    ORDER BY input.revision DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO result FROM run_results WHERE run_id=execution.id AND validity='valid' FOR SHARE;
  IF NOT FOUND OR result.schema_ref IS DISTINCT FROM execution.result_contract->>'schemaRef'
    OR result.schema_sha256 IS DISTINCT FROM execution.result_contract->>'sha256'
    OR to_jsonb(result.schema_version) IS DISTINCT FROM execution.result_contract->'schemaVersion'
    OR result.schema_ref IS DISTINCT FROM effective.objective_input->'expectedResult'->>'schemaRef'
    OR result.schema_sha256 IS DISTINCT FROM effective.objective_input->'expectedResult'->>'sha256'
    OR to_jsonb(result.schema_version) IS DISTINCT FROM effective.objective_input->'expectedResult'->'schemaVersion'
    OR NOT (execution.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
      'kind','assignment_input','assignmentId',subject.id,'inputRevision',effective.revision,'inputSha256',effective.digest))) THEN RETURN NEW; END IF;
  NEW.assignment_result:=jsonb_build_object(
    'schemaVersion',1,
    'owner',CASE WHEN subject.company_id IS NOT NULL THEN jsonb_build_object('kind','company','companyId',subject.company_id) ELSE jsonb_build_object('kind','project','projectId',subject.project_id) END,
    'assignmentId',subject.id,'inputRevision',effective.revision,'inputSha256',effective.digest,
    'requesterUserId',subject.requester->>'id','destination',subject.destination,
    'runId',execution.id,'resultRevision',result.revision,
    'resultSha256',encode(sha256(convert_to(jsonb_build_object('schemaRef',result.schema_ref,'schemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,'value',result.value)::text,'UTF8')),'hex'),
    'witnessAlgorithm','postgres_jsonb_sha256_v1','schemaRef',result.schema_ref,'resultSchemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,
    'sourceRestrictions',execution.knowledge_access->'restrictions');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_result_event_capture BEFORE INSERT OR UPDATE ON domain_events
FOR EACH ROW EXECUTE FUNCTION capture_specialist_result_witness();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_delivery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source domain_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Origin delivery identity and retained source witness are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_immutable';
  END IF;
  IF NEW.source_event_id !~ '^[1-9][0-9]{0,15}$' THEN
    RAISE EXCEPTION 'Origin delivery event identity is invalid'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_reference';
  END IF;
  SELECT * INTO source FROM domain_events WHERE id=NEW.source_event_id::bigint FOR SHARE;
  IF NOT FOUND OR source.assignment_result IS NULL OR source.assignment_result IS DISTINCT FROM NEW.snapshot
    OR source.run_id IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'Origin delivery requires its exact server-captured native result event'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_delivery_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON specialist_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION guard_specialist_delivery_receipt();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_delivery_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM webhook_events event WHERE event.id=NEW.outbox_event_id
    AND event.project_id IS NULL AND event.run_id IS NULL AND event.type='assignment.result_available'
    AND event.data=jsonb_build_object('ownerUserId',NEW.snapshot->>'requesterUserId','assignmentDeliveryId',NEW.id)) THEN
    RAISE EXCEPTION 'Origin delivery receipt and its exact private outbox intent must commit together'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_outbox_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_delivery_outbox_guard AFTER INSERT ON specialist_delivery_receipts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_specialist_delivery_outbox();
