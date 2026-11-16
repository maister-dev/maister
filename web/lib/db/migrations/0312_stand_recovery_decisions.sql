CREATE TABLE "stand_recovery_decisions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operation_id" text NOT NULL,
	"operation_revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"decision" text NOT NULL,
	"inspection_ids" jsonb NOT NULL,
	"reason" text NOT NULL,
	"authority" jsonb NOT NULL,
	"delivery_key" text NOT NULL,
	"decision_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_recovery_decisions_delivery_unique" UNIQUE("operation_id","actor_id","delivery_key"),
	CONSTRAINT "stand_recovery_decisions_revision_unique" UNIQUE("operation_id","operation_revision"),
	CONSTRAINT "stand_recovery_decisions_shape_check" CHECK ("stand_recovery_decisions"."operation_revision">0 AND "stand_recovery_decisions"."decision" IN ('hold','authorize_successor')
        AND "stand_recovery_decisions"."decision_digest" ~ '^[a-f0-9]{64}$'
        AND "stand_recovery_decisions"."delivery_key" ~ '^[A-Za-z0-9._:-]{8,128}$'
        AND char_length("stand_recovery_decisions"."reason")<=2000 AND "stand_recovery_decisions"."reason" ~ '[^[:space:]]'
        AND jsonb_typeof("stand_recovery_decisions"."authority")='object'
        AND jsonb_typeof("stand_recovery_decisions"."inspection_ids")='array' AND jsonb_array_length("stand_recovery_decisions"."inspection_ids")<=16)
);
--> statement-breakpoint
ALTER TABLE "stand_recovery_decisions" ADD CONSTRAINT "stand_recovery_decisions_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_recovery_decisions" ADD CONSTRAINT "stand_recovery_decisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;