CREATE TABLE "stand_read_claims" (
	"operation_id" text NOT NULL,
	"purpose" text NOT NULL,
	"actor_id" text NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"authority" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stand_read_claims_operation_id_purpose_pk" PRIMARY KEY("operation_id","purpose"),
	CONSTRAINT "stand_read_claims_shape_check" CHECK ("stand_read_claims"."purpose" IN ('reconcile','logs','verify') AND "stand_read_claims"."owner_epoch" BETWEEN 1 AND 9007199254740991 AND jsonb_typeof("stand_read_claims"."authority")='object')
);
--> statement-breakpoint
ALTER TABLE "stand_read_claims" ADD CONSTRAINT "stand_read_claims_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_read_claims" ADD CONSTRAINT "stand_read_claims_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;