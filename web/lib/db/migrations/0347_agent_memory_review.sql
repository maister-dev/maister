CREATE TABLE "agent_memory_external_tasks" (
	"task_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_promotions" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"note_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"proposal_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_proposal_payloads" (
	"vault_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"command" jsonb NOT NULL,
	CONSTRAINT "agent_memory_proposal_payloads_vault_id_proposal_id_pk" PRIMARY KEY("vault_id","proposal_id"),
	CONSTRAINT "agent_memory_proposal_command_check" CHECK (jsonb_typeof("agent_memory_proposal_payloads"."command")='object' AND octet_length("agent_memory_proposal_payloads"."command"::text)<=4200000)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_proposals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vault_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"author" jsonb NOT NULL,
	"source_project_ids" text[] NOT NULL,
	"source_restrictions" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"reviewer_id" text,
	"decision_key" text,
	"applied_operation_id" text,
	CONSTRAINT "agent_memory_proposal_vault_id_uq" UNIQUE("vault_id","id"),
	CONSTRAINT "agent_memory_proposal_operation_uq" UNIQUE("operation_id"),
	CONSTRAINT "agent_memory_proposal_shape_check" CHECK (
      "agent_memory_proposals"."state" IN ('pending','accepted','rejected','redacted')
      AND ("agent_memory_proposals"."state"='pending')=("agent_memory_proposals"."version"=1)
      AND "agent_memory_proposals"."version" BETWEEN 1 AND 2
      AND ("agent_memory_proposals"."state"='pending')=("agent_memory_proposals"."decided_at" IS NULL)
      AND ("agent_memory_proposals"."state"='accepted')=("agent_memory_proposals"."applied_operation_id" IS NOT NULL)
      AND (("agent_memory_proposals"."state" IN ('accepted','rejected'))=(num_nonnulls("agent_memory_proposals"."reviewer_id", "agent_memory_proposals"."decision_key")=2))
      AND cardinality("agent_memory_proposals"."source_project_ids")<=256
      AND jsonb_typeof("agent_memory_proposals"."author")='object'
      AND jsonb_typeof("agent_memory_proposals"."source_restrictions")='array' AND octet_length("agent_memory_proposals"."source_restrictions"::text)<=65536
      AND jsonb_typeof("agent_memory_proposals"."changes")='array' AND jsonb_array_length("agent_memory_proposals"."changes") BETWEEN 1 AND 1024
    )
);
--> statement-breakpoint
CREATE TABLE "agent_memory_tainted_runs" (
	"run_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_review_receipts" (
	"id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_review_receipts_user_id_request_key_pk" PRIMARY KEY("user_id","request_key"),
	CONSTRAINT "inbox_review_receipts_id_unique" UNIQUE("id"),
	CONSTRAINT "inbox_review_receipt_digest_check" CHECK ("inbox_review_receipts"."digest" ~ '^[a-f0-9]{64}$' AND "inbox_review_receipts"."request_key" ~ '^[A-Za-z0-9_.:-]{8,128}$')
);
--> statement-breakpoint
ALTER TABLE "agent_memory_redactions" DROP CONSTRAINT "agent_memory_redaction_reason_check";--> statement-breakpoint
ALTER TABLE "agent_memory_injections" ADD COLUMN "requires_review_at_launch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory_redactions" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "memory_write_policy" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory_promotions" ADD CONSTRAINT "agent_memory_promotion_source_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_promotions" ADD CONSTRAINT "agent_memory_promotion_operation_fk" FOREIGN KEY ("vault_id","operation_id") REFERENCES "public"."agent_memory_operations"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_proposal_payloads" ADD CONSTRAINT "agent_memory_proposal_payload_owner_fk" FOREIGN KEY ("vault_id","proposal_id") REFERENCES "public"."agent_memory_proposals"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_proposals" ADD CONSTRAINT "agent_memory_proposal_operation_fk" FOREIGN KEY ("vault_id","operation_id") REFERENCES "public"."agent_memory_operations"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_proposals" ADD CONSTRAINT "agent_memory_proposal_applied_operation_fk" FOREIGN KEY ("vault_id","applied_operation_id") REFERENCES "public"."agent_memory_operations"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memory_proposal_queue_idx" ON "agent_memory_proposals" USING btree ("vault_id","created_at","id") WHERE "agent_memory_proposals"."state"='pending';--> statement-breakpoint
ALTER TABLE "agent_memory_redactions" ADD CONSTRAINT "agent_memory_redaction_request_uq" UNIQUE("administrator_id","request_key");--> statement-breakpoint
ALTER TABLE "agent_memory_redactions" ADD CONSTRAINT "agent_memory_redaction_reason_check" CHECK (char_length(btrim("agent_memory_redactions"."reason")) BETWEEN 1 AND 1024 AND ("agent_memory_redactions"."request_key" IS NULL OR "agent_memory_redactions"."request_key" ~ '^[A-Za-z0-9_.:-]{8,128}$'));--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD CONSTRAINT "agent_project_links_memory_write_policy_check" CHECK ("agent_project_links"."memory_write_policy" IN ('auto','review'));
--> statement-breakpoint
INSERT INTO agent_memory_tainted_runs(run_id)
SELECT id FROM runs WHERE trigger_source='webhook' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO agent_memory_external_tasks(task_id)
SELECT DISTINCT task_id FROM task_external_sources ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION agent_memory_capture_external_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='task_external_sources' THEN
    INSERT INTO agent_memory_external_tasks(task_id) VALUES (NEW.task_id) ON CONFLICT DO NOTHING;
  ELSIF NEW.trigger_source='webhook' THEN
    INSERT INTO agent_memory_tainted_runs(run_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_memory_capture_webhook_run
AFTER INSERT OR UPDATE OF trigger_source ON runs
FOR EACH ROW EXECUTE FUNCTION agent_memory_capture_external_source();
--> statement-breakpoint
CREATE TRIGGER agent_memory_capture_external_task
AFTER INSERT OR UPDATE OF task_id ON task_external_sources
FOR EACH ROW EXECUTE FUNCTION agent_memory_capture_external_source();
