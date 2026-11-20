ALTER TABLE "agent_memory_import_receipts" ADD COLUMN "source_project_id" text;--> statement-breakpoint
ALTER TABLE "agent_memory_import_receipts" ADD COLUMN "source_agent_id" text;--> statement-breakpoint
-- A receipt without a retained destination has no recoverable project witness.
UPDATE agent_memory_import_receipts receipt
  SET source_project_id = vault.project_id, source_agent_id = vault.agent_id
  FROM agent_memory_vaults vault
  WHERE receipt.source_kind = 'note' AND receipt.vault_id = vault.id
    AND vault.project_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_memory_import_receipts" ADD CONSTRAINT "agent_memory_import_note_owner_check" CHECK (num_nonnulls("agent_memory_import_receipts"."source_project_id", "agent_memory_import_receipts"."source_agent_id") = 0
        OR ("agent_memory_import_receipts"."source_kind" = 'note' AND coalesce(length("agent_memory_import_receipts"."source_project_id"), 0) > 0
          AND coalesce(length("agent_memory_import_receipts"."source_agent_id"), 0) > 0));
