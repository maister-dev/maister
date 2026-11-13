ALTER TABLE "workspaces" ADD COLUMN "branch_delivery" jsonb;
--> statement-breakpoint
DROP TRIGGER workspaces_peek_hint ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspaces_peek_hint AFTER INSERT OR UPDATE OR DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('summary','run_id,removed_at,branch_delivery');
