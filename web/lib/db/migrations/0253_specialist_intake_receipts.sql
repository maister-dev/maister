CREATE TABLE "specialist_intake_receipts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"disposition" text DEFAULT 'created' NOT NULL,
	"assignment_id" text NOT NULL,
	"input_revision" integer NOT NULL,
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_intake_receipts_delivery_uq" UNIQUE("source_kind","source_key"),
	CONSTRAINT "specialist_intake_receipts_shape_check" CHECK (("specialist_intake_receipts"."source_kind" IN ('manual','task_comment','schedule','event','webhook','delegation') AND "specialist_intake_receipts"."source_key" ~ '^[a-f0-9]{64}$' AND "specialist_intake_receipts"."request_digest" ~ '^[a-f0-9]{64}$' AND "specialist_intake_receipts"."disposition"='created' AND "specialist_intake_receipts"."input_revision">0 AND char_length("specialist_intake_receipts"."assignment_id") BETWEEN 1 AND 128) IS TRUE),
	CONSTRAINT "specialist_intake_receipts_actor_check" CHECK ((CASE WHEN jsonb_typeof("specialist_intake_receipts"."actor")='object' THEN
    "specialist_intake_receipts"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_intake_receipts"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_intake_receipts"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_intake_receipts"."actor"->'id')='string'
    AND char_length("specialist_intake_receipts"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_intake_receipts"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_intake_receipts"."actor"->'runId')='string' AND char_length("specialist_intake_receipts"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_intake_receipts"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_intake_receipts"."actor"->'attemptId')='string' AND char_length("specialist_intake_receipts"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "specialist_intake_receipts" ADD CONSTRAINT "specialist_intake_receipts_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_intake_receipts_assignment_idx" ON "specialist_intake_receipts" USING btree ("assignment_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION guard_specialist_intake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Specialist intake receipts are immutable'
      USING ERRCODE='23514', CONSTRAINT='specialist_intake_receipts_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments assignment
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id
      AND input.revision=NEW.input_revision
    WHERE assignment.id=NEW.assignment_id
      AND assignment.origin->>'kind'=NEW.source_kind
      AND input.actor=NEW.actor
  ) THEN
    RAISE EXCEPTION 'Specialist intake receipt must identify its exact source and server-attributed input'
      USING ERRCODE='23514', CONSTRAINT='specialist_intake_receipts_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_intake_receipts_guard
BEFORE INSERT OR UPDATE OR DELETE ON specialist_intake_receipts
FOR EACH ROW EXECUTE FUNCTION guard_specialist_intake_receipt();
