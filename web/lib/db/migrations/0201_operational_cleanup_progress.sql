CREATE TABLE "operational_cleanup_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_operational_contract_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_operational_contract_check" CHECK ((("runs"."agent_kind" IS NULL OR "runs"."agent_kind" = 'code_delivery') AND coalesce("runs"."result_contract"->>'kind', '') <> 'agent_operational' OR "runs"."agent_kind" = 'operational' AND "runs"."run_kind" = 'agent' AND "runs"."persistent" = false AND NOT (coalesce("runs"."workspace_mode", 'own') = 'shared' AND "runs"."agent_workspace" = 'worktree') AND "runs"."agent_workspace" IN ('none','repo_read','worktree') AND "runs"."result_contract"->>'kind' = 'agent_operational' AND "runs"."result_contract"->'schemaVersion' = '1'::jsonb AND "runs"."result_contract"->'semanticVersion' = '1'::jsonb AND "runs"."result_contract"->'required' = 'true'::jsonb AND "runs"."result_contract"->>'sha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof("runs"."result_contract"->'schema') = 'object' AND jsonb_typeof("runs"."result_contract"->'definition') = 'object' AND jsonb_typeof("runs"."result_contract"->'provenance') = 'object') IS TRUE);