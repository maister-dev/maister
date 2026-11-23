CREATE TABLE "flow_node_restart_checkpoints" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"checkpoint_sha" text NOT NULL,
	"preview_token" text NOT NULL,
	"rescue_ref" text
);
--> statement-breakpoint
ALTER TABLE "flow_node_restart_checkpoints" ADD CONSTRAINT "flow_node_restart_checkpoints_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_node_restart_checkpoints" ADD CONSTRAINT "flow_node_restart_checkpoints_attempt_id_node_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_node_restart_checkpoints_attempt_idx" ON "flow_node_restart_checkpoints" USING btree ("attempt_id");