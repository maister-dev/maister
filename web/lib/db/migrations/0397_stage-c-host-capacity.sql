CREATE TABLE "execution_host_slot_reservations" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_host_slot_reservations" ADD CONSTRAINT "execution_host_slot_reservations_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "execution_host_slot_reservations" ("assignment_id", "reserved_at")
SELECT a.id, coalesce(r.started_at, a.created_at)
FROM "execution_assignments" a
JOIN "execution_hosts" h ON h.id=a.execution_host_id
JOIN "runs" r ON r.id=a.run_id
WHERE h.capabilities ? 'workspaceProtocol'
  AND ((a.state='active' AND r.status IN ('Running','NeedsInput')) OR EXISTS (
    SELECT 1 FROM "execution_commands" c
    WHERE c.execution_assignment_id=a.id AND c.attempts>0
      AND c.kind IN ('workspace.prepare','workspace.materialize','workspace.run','session.create','session.prompt')
      AND (c.state IN ('accepted','delivering','queued','fenced')
        OR c.transport_state IN ('unknown','reconciliation_required'))
  ) OR EXISTS (
    SELECT 1 FROM "run_session_incarnations" i
    WHERE i.execution_assignment_id=a.id AND i.state IN ('created','active','checkpointed','lost')
  ));
