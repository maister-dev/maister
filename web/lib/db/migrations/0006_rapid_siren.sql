ALTER TABLE "users" ADD COLUMN "account_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_status_updated_by" text;--> statement-breakpoint
UPDATE "users"
SET "account_status" = 'active',
    "account_status_updated_at" = now()
WHERE "account_status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_account_status_idx" ON "users" USING btree ("account_status");
