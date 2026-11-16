CREATE TABLE "stand_incident_episodes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"resource_key" text NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"first_operation_id" text NOT NULL,
	"last_operation_id" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"recovery_verification_id" text,
	CONSTRAINT "stand_incident_episode_shape_check" CHECK ("stand_incident_episodes"."resource_key" ~ '^[a-f0-9]{64}$'
      AND "stand_incident_episodes"."reason" IN ('verification_unhealthy','verification_inconclusive')
      AND "stand_incident_episodes"."occurrence_count">0 AND "stand_incident_episodes"."last_at">="stand_incident_episodes"."first_at"
      AND (("stand_incident_episodes"."state"='open' AND "stand_incident_episodes"."resolved_at" IS NULL AND "stand_incident_episodes"."recovery_verification_id" IS NULL)
        OR ("stand_incident_episodes"."state"='resolved' AND "stand_incident_episodes"."resolved_at">="stand_incident_episodes"."last_at" AND "stand_incident_episodes"."recovery_verification_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "stand_incident_episodes" ADD CONSTRAINT "stand_incident_episodes_first_operation_id_stand_operations_id_fk" FOREIGN KEY ("first_operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_incident_episodes" ADD CONSTRAINT "stand_incident_episodes_last_operation_id_stand_operations_id_fk" FOREIGN KEY ("last_operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_incident_episodes" ADD CONSTRAINT "stand_incident_episodes_recovery_verification_id_stand_verifications_id_fk" FOREIGN KEY ("recovery_verification_id") REFERENCES "public"."stand_verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stand_incident_open_resource_reason_uq" ON "stand_incident_episodes" USING btree ("resource_key","reason") WHERE "stand_incident_episodes"."state"='open';--> statement-breakpoint
CREATE INDEX "stand_incident_resource_timeline_idx" ON "stand_incident_episodes" USING btree ("resource_key","last_at","id");