CREATE TABLE "stand_restart_approvals" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"approved_by" text NOT NULL,
	"request_digest" text NOT NULL,
	"operation_revision" integer NOT NULL,
	"approval_digest" text NOT NULL,
	"delivery_key" text NOT NULL,
	"reason" text NOT NULL,
	"authority" jsonb NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_restart_approvals_shape_check" CHECK ("stand_restart_approvals"."operation_revision">0 AND "stand_restart_approvals"."request_digest" ~ '^[a-f0-9]{64}$' AND "stand_restart_approvals"."approval_digest" ~ '^[a-f0-9]{64}$' AND "stand_restart_approvals"."delivery_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND char_length("stand_restart_approvals"."reason")<=2000 AND "stand_restart_approvals"."reason" ~ '[^[:space:]]' AND jsonb_typeof("stand_restart_approvals"."authority")='object')
);
--> statement-breakpoint
ALTER TABLE "stand_restart_approvals" ADD CONSTRAINT "stand_restart_approvals_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_restart_approvals" ADD CONSTRAINT "stand_restart_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;