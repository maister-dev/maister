CREATE TABLE "stand_authorization_permits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operation_id" text NOT NULL,
	"nonce" text NOT NULL,
	"purpose" text NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stand_authorization_permits_operation_nonce_unique" UNIQUE("operation_id","nonce"),
	CONSTRAINT "stand_authorization_permits_shape_check" CHECK ("stand_authorization_permits"."owner_epoch" BETWEEN 1 AND 9007199254740991 AND "stand_authorization_permits"."purpose" IN ('dispatch','reconcile','logs','verify')
        AND "stand_authorization_permits"."nonce" ~ '^[A-Za-z0-9._:-]{8,128}$'
        AND "stand_authorization_permits"."expires_at" > "stand_authorization_permits"."issued_at" AND "stand_authorization_permits"."expires_at" <= "stand_authorization_permits"."issued_at" + interval '5 seconds')
);
--> statement-breakpoint
ALTER TABLE "stand_authorization_permits" ADD CONSTRAINT "stand_authorization_permits_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stand_authorization_permits_dispatch_unique" ON "stand_authorization_permits" USING btree ("operation_id") WHERE "stand_authorization_permits"."purpose"='dispatch';