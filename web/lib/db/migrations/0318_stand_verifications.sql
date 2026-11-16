CREATE TABLE "stand_verifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operation_id" text NOT NULL,
	"effect_receipt_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"nonce" text NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"target_probe_id" text NOT NULL,
	"target_sequence" bigint NOT NULL,
	"state" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_verifications_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "stand_verifications_target_probe_id_unique" UNIQUE("target_probe_id"),
	CONSTRAINT "stand_verifications_operation_sequence_unique" UNIQUE("operation_id","target_sequence"),
	CONSTRAINT "stand_verifications_shape_check" CHECK ("stand_verifications"."state" IN ('healthy','unhealthy','inconclusive')
      AND "stand_verifications"."owner_epoch" BETWEEN 1 AND 9007199254740991 AND "stand_verifications"."target_sequence" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "stand_verifications" ADD CONSTRAINT "stand_verifications_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_verifications" ADD CONSTRAINT "stand_verifications_effect_receipt_id_stand_operation_receipts_id_fk" FOREIGN KEY ("effect_receipt_id") REFERENCES "public"."stand_operation_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_verifications" ADD CONSTRAINT "stand_verifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;