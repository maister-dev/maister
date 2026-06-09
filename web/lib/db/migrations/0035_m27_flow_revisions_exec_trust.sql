ALTER TABLE "flow_revisions" ADD COLUMN "exec_trust" text DEFAULT 'untrusted' NOT NULL;
--> statement-breakpoint
ALTER TABLE "flow_revisions" ADD CONSTRAINT "flow_revisions_exec_trust_ck" CHECK ("exec_trust" IN ('untrusted','trusted'));
