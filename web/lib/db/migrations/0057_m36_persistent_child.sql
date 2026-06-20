ALTER TABLE "runs" ADD COLUMN "persistent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "addressable_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_root_addressable_key_uq" ON "runs" USING btree ("root_run_id","addressable_key") WHERE "runs"."persistent" = true;