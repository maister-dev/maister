CREATE TABLE "agent_memory_note_index" (
	"vault_id" text NOT NULL,
	"note_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"path" text NOT NULL,
	"basename_key" text NOT NULL,
	"tags" jsonb NOT NULL,
	"aliases" jsonb NOT NULL,
	"alias_keys" jsonb NOT NULL,
	"headings" jsonb NOT NULL,
	"state" text NOT NULL,
	"document" "tsvector" NOT NULL,
	CONSTRAINT "agent_memory_note_index_vault_id_note_id_pk" PRIMARY KEY("vault_id","note_id"),
	CONSTRAINT "agent_memory_index_head_version_uq" UNIQUE("vault_id","note_id","revision_id"),
	CONSTRAINT "agent_memory_index_live_path_uq" UNIQUE("vault_id","path"),
	CONSTRAINT "agent_memory_index_metadata_check" CHECK (
      "agent_memory_note_index"."state" IN ('ready','repair')
      AND jsonb_typeof("agent_memory_note_index"."tags")='array' AND jsonb_array_length("agent_memory_note_index"."tags") <= 64
      AND jsonb_typeof("agent_memory_note_index"."aliases")='array' AND jsonb_array_length("agent_memory_note_index"."aliases") <= 64
      AND jsonb_typeof("agent_memory_note_index"."alias_keys")='array' AND jsonb_array_length("agent_memory_note_index"."alias_keys") = jsonb_array_length("agent_memory_note_index"."aliases")
      AND jsonb_typeof("agent_memory_note_index"."headings")='array' AND jsonb_array_length("agent_memory_note_index"."headings") <= 512)
);
--> statement-breakpoint
CREATE TABLE "agent_memory_note_links" (
	"vault_id" text NOT NULL,
	"source_note_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"raw" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"fragment" text,
	"lookup_path" text,
	"lookup_key" text,
	"target_note_id" text,
	"state" text NOT NULL,
	CONSTRAINT "agent_memory_note_links_vault_id_source_note_id_raw_pk" PRIMARY KEY("vault_id","source_note_id","raw"),
	CONSTRAINT "agent_memory_link_shape_check" CHECK (
      octet_length("agent_memory_note_links"."raw") BETWEEN 1 AND 512
      AND "agent_memory_note_links"."kind" IN ('note','task','run','brain','knowledge','repo','unresolved')
      AND "agent_memory_note_links"."state" IN ('resolved','unresolved','pointer')
      AND (("agent_memory_note_links"."kind"='note')=(num_nonnulls("agent_memory_note_links"."lookup_path","agent_memory_note_links"."lookup_key")=2))
      AND (("agent_memory_note_links"."state"='resolved')=("agent_memory_note_links"."target_note_id" IS NOT NULL))
      AND ("agent_memory_note_links"."target_note_id" IS NULL OR "agent_memory_note_links"."kind"='note'))
);
--> statement-breakpoint
ALTER TABLE "agent_memory_note_index" ADD CONSTRAINT "agent_memory_index_revision_fk" FOREIGN KEY ("vault_id","note_id","revision_id") REFERENCES "public"."agent_memory_revisions"("vault_id","note_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_note_links" ADD CONSTRAINT "agent_memory_link_projection_fk" FOREIGN KEY ("vault_id","source_note_id","source_revision_id") REFERENCES "public"."agent_memory_note_index"("vault_id","note_id","revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_note_links" ADD CONSTRAINT "agent_memory_link_same_vault_target_fk" FOREIGN KEY ("vault_id","target_note_id") REFERENCES "public"."agent_memory_notes"("vault_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memory_index_basename_idx" ON "agent_memory_note_index" USING btree ("vault_id","basename_key");--> statement-breakpoint
CREATE INDEX "agent_memory_index_tags_gin" ON "agent_memory_note_index" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "agent_memory_index_alias_keys_gin" ON "agent_memory_note_index" USING gin ("alias_keys");--> statement-breakpoint
CREATE INDEX "agent_memory_index_document_gin" ON "agent_memory_note_index" USING gin ("document");--> statement-breakpoint
CREATE INDEX "agent_memory_link_target_idx" ON "agent_memory_note_links" USING btree ("vault_id","target_note_id");