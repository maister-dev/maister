ALTER TABLE "webhook_deliveries" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "push_subscription_id" text;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_push_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("push_subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_push_event_uq" ON "webhook_deliveries" USING btree ("push_subscription_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_owner_idx" ON "webhook_subscriptions" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_one_target" CHECK (("webhook_deliveries"."subscription_id" IS NULL) <> ("webhook_deliveries"."push_subscription_id" IS NULL));