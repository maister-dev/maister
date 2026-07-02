ALTER TABLE "agent_project_links" ADD COLUMN "can_read_brain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "can_write_brain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "embedding_base_url" text;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "embedding_api_key_ref" text;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "distill_model" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brain_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "brain_context" boolean;