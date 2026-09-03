ALTER TABLE "platform_acp_runners" DROP CONSTRAINT IF EXISTS "platform_acp_runners_sidecar_id_platform_router_sidecars_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "platform_acp_runners_sidecar_idx";--> statement-breakpoint
ALTER TABLE "platform_acp_runners" DROP COLUMN IF EXISTS "sidecar_id";--> statement-breakpoint
DROP TABLE IF EXISTS "platform_router_sidecars";
