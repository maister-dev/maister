CREATE TABLE "agent_memory_cutover" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"generation" bigint NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_cutover_active_check" CHECK ("agent_memory_cutover"."singleton" AND "agent_memory_cutover"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_import_payloads" (
	"receipt_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_import_receipts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"generation" bigint NOT NULL,
	"source_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_digest" text,
	"source_bytes" integer,
	"state" text NOT NULL,
	"vault_id" text,
	"note_id" text,
	"revision_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_import_source_uq" UNIQUE("generation","source_kind","source_identity"),
	CONSTRAINT "agent_memory_import_witness_check" CHECK ("agent_memory_import_receipts"."generation" > 0
        AND "agent_memory_import_receipts"."source_kind" IN ('note', 'run_snapshot')
        AND "agent_memory_import_receipts"."state" IN ('inventoried', 'imported', 'verified', 'cleaned', 'missing', 'mismatched')
        AND num_nonnulls("agent_memory_import_receipts"."vault_id", "agent_memory_import_receipts"."note_id", "agent_memory_import_receipts"."revision_id") IN (0, 3)
        AND ("agent_memory_import_receipts"."source_kind" = 'run_snapshot') = ("agent_memory_import_receipts"."run_id" IS NOT NULL)
        AND ("agent_memory_import_receipts"."source_digest" IS NULL OR "agent_memory_import_receipts"."source_digest" ~ '^[0-9a-f]{64}$')
        AND ("agent_memory_import_receipts"."source_bytes" IS NULL OR "agent_memory_import_receipts"."source_bytes" >= 0))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_injections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vault_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text,
	"session_key" text NOT NULL,
	"protocol_version" text NOT NULL,
	"protocol_sha256" text NOT NULL,
	"tree" jsonb NOT NULL,
	"index_note_id" text,
	"index_revision_id" text,
	"descriptor_digest" text NOT NULL,
	"rendered_chars" integer NOT NULL,
	"application_state" text DEFAULT 'staged' NOT NULL,
	"application_receipt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_injection_session_uq" UNIQUE("run_id","session_key"),
	CONSTRAINT "agent_memory_injection_descriptor_check" CHECK (("agent_memory_injections"."index_note_id" IS NULL) = ("agent_memory_injections"."index_revision_id" IS NULL)
        AND "agent_memory_injections"."protocol_sha256" ~ '^[0-9a-f]{64}$'
        AND "agent_memory_injections"."descriptor_digest" ~ '^[0-9a-f]{64}$'
        AND "agent_memory_injections"."rendered_chars" BETWEEN 1 AND 262144
        AND jsonb_typeof("agent_memory_injections"."tree") = 'object'),
	CONSTRAINT "agent_memory_injection_application_check" CHECK ("agent_memory_injections"."application_state" IN ('staged', 'applied', 'retired')
        AND ("agent_memory_injections"."application_state" = 'applied') = ("agent_memory_injections"."application_receipt_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vault_id" text NOT NULL,
	"path" text NOT NULL,
	"head_revision_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_memory_note_vault_id_uq" UNIQUE("vault_id","id"),
	CONSTRAINT "agent_memory_note_path_check" CHECK (left("agent_memory_notes"."path", 10) = '/memories/' AND right("agent_memory_notes"."path", 3) = '.md' AND octet_length("agent_memory_notes"."path") <= 512)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_operation_revisions" (
	"vault_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"role" text NOT NULL,
	"ordinal" integer NOT NULL,
	"note_id" text NOT NULL,
	"revision_id" text NOT NULL,
	CONSTRAINT "agent_memory_operation_revisions_vault_id_operation_id_role_ordinal_pk" PRIMARY KEY("vault_id","operation_id","role","ordinal"),
	CONSTRAINT "agent_memory_operation_ref_check" CHECK ("agent_memory_operation_revisions"."role" IN ('base', 'result') AND "agent_memory_operation_revisions"."ordinal" BETWEEN 0 AND 1023)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_operations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vault_id" text NOT NULL,
	"principal_key" text NOT NULL,
	"request_key" text NOT NULL,
	"command_kind" text NOT NULL,
	"command_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_operation_vault_id_uq" UNIQUE("vault_id","id"),
	CONSTRAINT "agent_memory_operation_request_uq" UNIQUE("vault_id","principal_key","request_key"),
	CONSTRAINT "agent_memory_operation_receipt_check" CHECK ("agent_memory_operations"."outcome" IN ('applied', 'pending')
        AND "agent_memory_operations"."command_digest" ~ '^[0-9a-f]{64}$'
        AND "agent_memory_operations"."request_key" ~ '^[A-Za-z0-9_.:-]{8,128}$')
);
--> statement-breakpoint
CREATE TABLE "agent_memory_redactions" (
	"vault_id" text NOT NULL,
	"note_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"administrator_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_redactions_vault_id_note_id_revision_id_pk" PRIMARY KEY("vault_id","note_id","revision_id"),
	CONSTRAINT "agent_memory_redaction_id_uq" UNIQUE("id"),
	CONSTRAINT "agent_memory_redaction_reason_check" CHECK (char_length(btrim("agent_memory_redactions"."reason")) BETWEEN 1 AND 1024)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_revision_payloads" (
	"vault_id" text NOT NULL,
	"note_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "agent_memory_revision_payloads_vault_id_note_id_revision_id_pk" PRIMARY KEY("vault_id","note_id","revision_id"),
	CONSTRAINT "agent_memory_payload_bytes_check" CHECK (octet_length("agent_memory_revision_payloads"."content") <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_revisions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vault_id" text NOT NULL,
	"note_id" text NOT NULL,
	"parent_revision_id" text,
	"operation_id" text,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"content_sha256" text,
	"size_chars" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"author" jsonb NOT NULL,
	"source_restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_project_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_revision_owner_uq" UNIQUE("vault_id","note_id","id"),
	CONSTRAINT "agent_memory_revision_content_check" CHECK (("agent_memory_revisions"."kind" = 'created') = ("agent_memory_revisions"."parent_revision_id" IS NULL)
        AND ("agent_memory_revisions"."parent_revision_id" IS NULL OR "agent_memory_revisions"."id" <> "agent_memory_revisions"."parent_revision_id")
        AND "agent_memory_revisions"."kind" IN ('created', 'edited', 'renamed', 'deleted', 'reverted', 'redacted')
        AND CASE WHEN "agent_memory_revisions"."kind" IN ('deleted', 'redacted')
          THEN "agent_memory_revisions"."content_sha256" IS NULL AND "agent_memory_revisions"."size_chars" = 0 AND "agent_memory_revisions"."size_bytes" = 0
          ELSE ("agent_memory_revisions"."content_sha256" ~ '^[0-9a-f]{64}$') IS TRUE
            AND "agent_memory_revisions"."size_chars" BETWEEN 0 AND 262144 AND "agent_memory_revisions"."size_bytes" BETWEEN 0 AND 1048576
          END),
	CONSTRAINT "agent_memory_revision_provenance_check" CHECK (jsonb_typeof("agent_memory_revisions"."author") = 'object'
        AND ("agent_memory_revisions"."author"->>'kind' IN ('human', 'librarian', 'agent_session', 'operator_import')) IS TRUE
        AND jsonb_typeof("agent_memory_revisions"."source_restrictions") = 'array'
        AND octet_length("agent_memory_revisions"."source_restrictions"::text) <= 65536
        AND cardinality("agent_memory_revisions"."source_project_ids") <= 256)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_vaults" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text,
	"company_id" text,
	"generation" bigint DEFAULT 0 NOT NULL,
	"note_count" integer DEFAULT 0 NOT NULL,
	"content_chars" integer DEFAULT 0 NOT NULL,
	"content_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_vault_owner_check" CHECK (num_nonnulls("agent_memory_vaults"."project_id", "agent_memory_vaults"."company_id") = 1 AND "agent_memory_vaults"."agent_id" ~ '^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$'),
	CONSTRAINT "agent_memory_vault_totals_check" CHECK ("agent_memory_vaults"."generation" >= 0 AND "agent_memory_vaults"."note_count" >= 0 AND "agent_memory_vaults"."content_chars" >= 0 AND "agent_memory_vaults"."content_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_memory_hash_format" text;--> statement-breakpoint
ALTER TABLE "agent_memory_import_payloads" ADD CONSTRAINT "agent_memory_import_payloads_receipt_id_agent_memory_import_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."agent_memory_import_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_import_receipts" ADD CONSTRAINT "agent_memory_import_revision_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_injections" ADD CONSTRAINT "agent_memory_injections_vault_id_agent_memory_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."agent_memory_vaults"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_injections" ADD CONSTRAINT "agent_memory_injection_index_fk" FOREIGN KEY ("vault_id","index_note_id","index_revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_notes" ADD CONSTRAINT "agent_memory_notes_vault_id_agent_memory_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."agent_memory_vaults"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_operation_revisions" ADD CONSTRAINT "agent_memory_operation_ref_operation_fk" FOREIGN KEY ("vault_id","operation_id") REFERENCES "public"."agent_memory_operations"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_operation_revisions" ADD CONSTRAINT "agent_memory_operation_ref_revision_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_operations" ADD CONSTRAINT "agent_memory_operations_vault_id_agent_memory_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."agent_memory_vaults"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_redactions" ADD CONSTRAINT "agent_memory_redaction_revision_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_revision_payloads" ADD CONSTRAINT "agent_memory_payload_revision_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revision_note_fk" FOREIGN KEY ("vault_id","note_id") REFERENCES "public"."agent_memory_notes"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revision_parent_fk" FOREIGN KEY ("vault_id","note_id","parent_revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revision_operation_fk" FOREIGN KEY ("vault_id","operation_id") REFERENCES "public"."agent_memory_operations"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_vaults" ADD CONSTRAINT "agent_memory_vaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_note_live_path_uq" ON "agent_memory_notes" USING btree ("vault_id","path" COLLATE "C") WHERE "agent_memory_notes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_revision_first_uq" ON "agent_memory_revisions" USING btree ("note_id") WHERE "agent_memory_revisions"."parent_revision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_revision_child_uq" ON "agent_memory_revisions" USING btree ("parent_revision_id") WHERE "agent_memory_revisions"."parent_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_memory_revision_history_idx" ON "agent_memory_revisions" USING btree ("vault_id","note_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_vault_project_uq" ON "agent_memory_vaults" USING btree ("project_id","agent_id") WHERE "agent_memory_vaults"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_vault_company_uq" ON "agent_memory_vaults" USING btree ("company_id","agent_id") WHERE "agent_memory_vaults"."company_id" IS NOT NULL;