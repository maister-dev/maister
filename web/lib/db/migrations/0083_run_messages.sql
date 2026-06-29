ALTER TABLE "scratch_messages" RENAME TO "run_messages";--> statement-breakpoint
ALTER TABLE "scratch_attachments" RENAME CONSTRAINT "scratch_attachments_message_id_scratch_messages_id_fk" TO "scratch_attachments_message_id_run_messages_id_fk";--> statement-breakpoint
ALTER TABLE "run_messages" DROP CONSTRAINT "scratch_messages_run_id_scratch_runs_run_id_fk";--> statement-breakpoint
ALTER TABLE "run_messages" DROP CONSTRAINT "scratch_messages_run_sequence_uq";--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "node_attempt_id" text;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_node_attempt_sequence_uq" UNIQUE NULLS NOT DISTINCT("run_id","node_attempt_id","sequence");
