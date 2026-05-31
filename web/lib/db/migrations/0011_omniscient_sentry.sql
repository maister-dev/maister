ALTER TABLE "node_attempts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "returned_commits" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "returned_diff" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
