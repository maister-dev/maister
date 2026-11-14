CREATE TABLE "specialist_assignment_control_receipts" (
	"assignment_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_assignment_control_receipts_pk" PRIMARY KEY("assignment_id","actor_user_id","action","idempotency_key"),
	CONSTRAINT "specialist_assignment_control_receipts_shape_check" CHECK ("specialist_assignment_control_receipts"."action" IN ('input','continue','cancel') AND "specialist_assignment_control_receipts"."revision" BETWEEN 1 AND 2147483647 AND "specialist_assignment_control_receipts"."request_sha256" ~ '^[0-9a-f]{64}$' AND "specialist_assignment_control_receipts"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$')
);
--> statement-breakpoint
ALTER TABLE "specialist_assignment_control_receipts" ADD CONSTRAINT "specialist_assignment_control_receipts_assignment_id_specialist_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_assignment_control_receipts" ADD CONSTRAINT "specialist_assignment_control_receipts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;