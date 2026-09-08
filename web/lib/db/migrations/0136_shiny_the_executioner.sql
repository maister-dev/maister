ALTER TABLE "runs" ALTER COLUMN "execution_data_plane_mode" SET DEFAULT 'canonical_events_v1';--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_execution_data_plane_mode_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_execution_data_plane_mode_check" CHECK ("execution_data_plane_mode" IN ('canonical_events_v1'));
