CREATE TABLE "stand_operation_observations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operation_id" text NOT NULL,
	"target_incarnation" text NOT NULL,
	"resource_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"target_sequence" bigint NOT NULL,
	"invocation_id" text,
	"observed_state" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_operation_observations_sequence_unique" UNIQUE("operation_id","target_sequence"),
	CONSTRAINT "stand_operation_observations_shape_check" CHECK ("stand_operation_observations"."target_sequence" BETWEEN 1 AND 9007199254740991
        AND ("stand_operation_observations"."invocation_id" IS NULL OR "stand_operation_observations"."invocation_id" ~ '^[A-Za-z0-9._:-]{1,128}$')
        AND "stand_operation_observations"."observed_state" IN ('active','inactive','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "stand_operations" ADD CONSTRAINT "stand_operations_observation_identity_unique" UNIQUE("id","target_incarnation","resource_key","request_digest");
--> statement-breakpoint
ALTER TABLE "stand_operation_observations" ADD CONSTRAINT "stand_operation_observations_identity_fk" FOREIGN KEY ("operation_id","target_incarnation","resource_key","request_digest") REFERENCES "public"."stand_operations"("id","target_incarnation","resource_key","request_digest") ON DELETE restrict ON UPDATE no action;
