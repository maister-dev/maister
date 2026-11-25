CREATE INDEX "domain_events_project_occurred_idx" ON "domain_events" USING btree ("project_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "domain_events"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "librarian_messages_segment_seq_idx" ON "librarian_messages" USING btree ("segment_id","seq");--> statement-breakpoint
CREATE INDEX "librarian_turns_segment_knowledge_idx" ON "librarian_turns" USING btree ("segment_id") WHERE "librarian_turns"."knowledge_access" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_project_started_idx" ON "runs" USING btree ("project_id","started_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "runs_started_id_idx" ON "runs" USING btree ("started_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "runs_continuation_active_idx" ON "runs" USING btree ("run_kind","id") WHERE "runs"."status" IN ('Running', 'NeedsInput', 'NeedsInputIdle', 'WaitingOnChildren');--> statement-breakpoint
CREATE INDEX "runs_host_restart_recovery_idx" ON "runs" USING btree ("id") WHERE "runs"."status" = 'Crashed' AND "runs"."run_kind" = 'flow' AND "runs"."parent_run_id" IS NULL AND "runs"."agent_kind" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_settled_updated_idx" ON "webhook_deliveries" USING btree ("updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "webhook_deliveries"."status" IN ('delivered', 'dead');--> statement-breakpoint
CREATE INDEX "webhook_events_fanout_prune_idx" ON "webhook_events" USING btree ("fanout_at") WHERE "webhook_events"."fanout_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workspaces_run_created_idx" ON "workspaces" USING btree ("run_id","created_at" DESC NULLS FIRST,"id");