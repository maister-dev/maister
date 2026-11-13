CREATE TABLE "stand_operations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"assignment_id" text NOT NULL,
	"input_revision" integer NOT NULL,
	"input_sha256" text NOT NULL,
	"assignment_revision" integer NOT NULL,
	"target_id" text NOT NULL,
	"config_revision" integer NOT NULL,
	"component_id" text NOT NULL,
	"resource_key" text NOT NULL,
	"target_incarnation" text NOT NULL,
	"action" text NOT NULL,
	"initiating_user_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"delivery_digest" text NOT NULL,
	"request_digest" text NOT NULL,
	"authority" jsonb NOT NULL,
	"effect_state" text DEFAULT 'not_dispatched' NOT NULL,
	"verification_state" text DEFAULT 'not_checked' NOT NULL,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"predecessor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_operations_assignment_delivery_unique" UNIQUE("assignment_id","initiating_user_id","delivery_key"),
	CONSTRAINT "stand_operations_id_resource_unique" UNIQUE("id","resource_key"),
	CONSTRAINT "stand_operations_predecessor_unique" UNIQUE("predecessor_id"),
	CONSTRAINT "stand_operations_revisions_check" CHECK ("stand_operations"."input_revision">0 AND "stand_operations"."assignment_revision">0 AND "stand_operations"."revision">0),
	CONSTRAINT "stand_operations_digests_check" CHECK ("stand_operations"."input_sha256" ~ '^[a-f0-9]{64}$' AND "stand_operations"."resource_key" ~ '^[a-f0-9]{64}$' AND "stand_operations"."delivery_digest" ~ '^[a-f0-9]{64}$' AND "stand_operations"."request_digest" ~ '^[a-f0-9]{64}$' AND "stand_operations"."delivery_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
	CONSTRAINT "stand_operations_states_check" CHECK ("stand_operations"."action" IN ('inspect','logs','restart','verify') AND "stand_operations"."effect_state" IN ('not_dispatched','dispatching','confirmed_applied','confirmed_not_applied','unknown') AND "stand_operations"."verification_state" IN ('not_checked','healthy','unhealthy','inconclusive') AND "stand_operations"."disposition" IN ('pending','proved_applied','proved_not_applied','unresolved_hold','authorized_successor') AND jsonb_typeof("stand_operations"."authority")='array')
);
--> statement-breakpoint
CREATE TABLE "stand_resource_claims" (
	"canonical_resource_key" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"owner_epoch" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"unresolved" boolean DEFAULT true NOT NULL,
	CONSTRAINT "stand_resource_claims_epoch_check" CHECK ("stand_resource_claims"."owner_epoch" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "stand_operations" ADD CONSTRAINT "stand_operations_initiating_user_id_users_id_fk" FOREIGN KEY ("initiating_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_operations" ADD CONSTRAINT "stand_operations_predecessor_id_stand_operations_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_operations" ADD CONSTRAINT "stand_operations_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_operations" ADD CONSTRAINT "stand_operations_component_fk" FOREIGN KEY ("target_id","config_revision","component_id") REFERENCES "public"."stand_components"("target_id","config_revision","component_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_resource_claims" ADD CONSTRAINT "stand_resource_claims_exact_operation_fk" FOREIGN KEY ("operation_id","canonical_resource_key") REFERENCES "public"."stand_operations"("id","resource_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stand_resource_claims_expiry_idx" ON "stand_resource_claims" USING btree ("unresolved","expires_at");