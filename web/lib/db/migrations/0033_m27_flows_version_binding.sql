ALTER TABLE "flows" ADD COLUMN "version_binding" text DEFAULT 'latest' NOT NULL;
--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_version_binding_ck" CHECK ("version_binding" IN ('pinned','latest'));
