CREATE TABLE "webhook_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_types" jsonb NOT NULL,
	"signing_secret_ref" text NOT NULL,
	"secondary_signing_secret_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscriptions_method_ck" CHECK ("method" IN ('POST','PUT'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"fanout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"last_http_status" integer,
	"last_error_kind" text,
	"last_error_message" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_ck" CHECK ("status" IN ('pending','delivered','dead')),
	CONSTRAINT "webhook_deliveries_last_error_kind_ck" CHECK ("last_error_kind" IN ('timeout','network','http','config'))
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"error_kind" text,
	"error_detail" text,
	"response_snippet" text,
	CONSTRAINT "webhook_delivery_attempts_error_kind_ck" CHECK ("error_kind" IN ('timeout','network','http','config'))
);
--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "webhooks_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_project_idx" ON "webhook_subscriptions" ("project_id");--> statement-breakpoint
CREATE INDEX "webhook_events_pending_fanout_idx" ON "webhook_events" ("created_at") WHERE "webhook_events"."fanout_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_sub_event_uq" ON "webhook_deliveries" ("subscription_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_log_idx" ON "webhook_deliveries" ("subscription_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_attempts_delivery_attempt_uq" ON "webhook_delivery_attempts" ("delivery_id","attempt_no");--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_delivery_idx" ON "webhook_delivery_attempts" ("delivery_id");