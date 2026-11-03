ALTER TABLE "company_grants" DROP CONSTRAINT "company_grants_principal_check";--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "knowledge_actor" jsonb;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "knowledge_node_attempt_id" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_knowledge_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("knowledge_node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_tokens_knowledge_node_attempt_idx" ON "project_tokens" USING btree ("knowledge_node_attempt_id");--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_principal_check" CHECK ("company_grants"."principal_type" IN ('user','agent','system') AND length("company_grants"."principal_id") BETWEEN 1 AND 192);--> statement-breakpoint
ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_knowledge_actor_check" CHECK ("node_attempts"."knowledge_actor" IS NULL OR (jsonb_typeof("node_attempts"."knowledge_actor")='object' AND "node_attempts"."knowledge_actor"->'schemaVersion'='1'::jsonb AND jsonb_typeof("node_attempts"."knowledge_actor"->'agentId')='string' AND length("node_attempts"."knowledge_actor"->>'agentId') BETWEEN 1 AND 192 AND jsonb_typeof("node_attempts"."knowledge_actor"->'packageInstallId')='string' AND length("node_attempts"."knowledge_actor"->>'packageInstallId') BETWEEN 1 AND 128 AND jsonb_typeof("node_attempts"."knowledge_actor"->'packageName')='string' AND length("node_attempts"."knowledge_actor"->>'packageName') BETWEEN 1 AND 128 AND jsonb_typeof("node_attempts"."knowledge_actor"->'definitionSha256')='string' AND "node_attempts"."knowledge_actor"->>'definitionSha256' ~ '^[a-f0-9]{64}$' AND "node_attempts"."knowledge_actor" - ARRAY['schemaVersion','agentId','packageInstallId','packageName','definitionSha256']='{}'::jsonb AND pg_column_size("node_attempts"."knowledge_actor")<=8192) IS TRUE);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_knowledge_node_attempt_check" CHECK ("project_tokens"."knowledge_node_attempt_id" IS NULL OR ("project_tokens"."token_kind"='project' AND "project_tokens"."name" ~ '^orchestrator-run:.+$'));
--> statement-breakpoint
CREATE FUNCTION guard_native_knowledge_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.knowledge_actor IS NOT NULL AND NEW.knowledge_actor IS DISTINCT FROM OLD.knowledge_actor THEN
    RAISE EXCEPTION 'Native node role attribution is immutable; start a fresh attempt for a changed identity'
      USING ERRCODE='23514', CONSTRAINT='node_attempts_knowledge_actor_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER node_attempts_knowledge_actor_immutable
BEFORE UPDATE OF knowledge_actor ON node_attempts
FOR EACH ROW EXECUTE FUNCTION guard_native_knowledge_actor();
--> statement-breakpoint
CREATE FUNCTION guard_native_knowledge_token_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.knowledge_node_attempt_id IS DISTINCT FROM OLD.knowledge_node_attempt_id
    OR (OLD.knowledge_node_attempt_id IS NOT NULL AND ROW(NEW.name,NEW.token_kind,NEW.project_id) IS DISTINCT FROM ROW(OLD.name,OLD.token_kind,OLD.project_id)) THEN
    RAISE EXCEPTION 'Native coordinator token binding is immutable; issue a new token for a fresh attempt'
      USING ERRCODE='23514', CONSTRAINT='project_tokens_knowledge_node_attempt_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_tokens_knowledge_node_attempt_immutable
BEFORE UPDATE OF knowledge_node_attempt_id,name,token_kind,project_id ON project_tokens
FOR EACH ROW EXECUTE FUNCTION guard_native_knowledge_token_binding();
