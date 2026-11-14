CREATE TABLE "stand_recovery_attempts" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stand_recovery_attempts_shape_check" CHECK ("stand_recovery_attempts"."attempts" BETWEEN 1 AND 2147483647 AND "stand_recovery_attempts"."next_attempt_at">="stand_recovery_attempts"."last_attempt_at")
);
--> statement-breakpoint
ALTER TABLE "stand_recovery_attempts" ADD CONSTRAINT "stand_recovery_attempts_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stand_recovery_attempts_due_idx" ON "stand_recovery_attempts" USING btree ("next_attempt_at");