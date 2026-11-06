ALTER TABLE "project_tokens" DROP CONSTRAINT "project_tokens_agent_project_check";--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "company_run_id" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_company_run_id_runs_id_fk" FOREIGN KEY ("company_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_tokens_company_live_run_uq" ON "project_tokens" USING btree ("company_run_id") WHERE "project_tokens"."company_id" IS NOT NULL AND "project_tokens"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_company_scope_check" CHECK ((("project_tokens"."company_id" IS NULL AND "project_tokens"."company_run_id" IS NULL) OR ("project_tokens"."company_id" IS NOT NULL AND "project_tokens"."company_run_id" IS NOT NULL AND "project_tokens"."project_id" IS NULL AND "project_tokens"."token_kind"='agent' AND "project_tokens"."agent_id" IS NOT NULL AND "project_tokens"."name"='agent-run:'||"project_tokens"."company_run_id" AND "project_tokens"."expires_at" IS NOT NULL AND "project_tokens"."librarian_turn_id" IS NULL AND "project_tokens"."knowledge_node_attempt_id" IS NULL AND jsonb_typeof("project_tokens"."scopes")='array' AND "project_tokens"."scopes"<@'["knowledge:read","knowledge:propose"]'::jsonb)) IS TRUE);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_agent_project_check" CHECK ("project_tokens"."token_kind" != 'agent' OR ("project_tokens"."agent_id" IS NOT NULL AND (("project_tokens"."project_id" IS NOT NULL AND "project_tokens"."company_id" IS NULL AND "project_tokens"."company_run_id" IS NULL) OR ("project_tokens"."project_id" IS NULL AND "project_tokens"."company_id" IS NOT NULL AND "project_tokens"."company_run_id" IS NOT NULL))));--> statement-breakpoint
CREATE FUNCTION guard_company_agent_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.company_id IS NULL AND NEW.company_id IS NULL AND OLD.company_run_id IS NULL AND NEW.company_run_id IS NULL THEN RETURN NEW; END IF;
    IF ROW(NEW.id,NEW.company_id,NEW.company_run_id,NEW.project_id,NEW.name,NEW.token_kind,NEW.agent_id,NEW.prefix,NEW.token_hash,NEW.scopes,NEW.expires_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.company_run_id,OLD.project_id,OLD.name,OLD.token_kind,OLD.agent_id,OLD.prefix,OLD.token_hash,OLD.scopes,OLD.expires_at,OLD.created_at)
      OR (NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Company run credentials cannot be retargeted, widened or reactivated; rotate the credential'
        USING ERRCODE='23514', CONSTRAINT='project_tokens_company_binding_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM runs execution
    JOIN specialist_run_links link ON link.run_id=execution.id
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision
    JOIN company_specialist_bindings binding ON binding.id=assignment.specialist_binding_id AND binding.company_id=execution.company_id AND binding.enabled AND binding.detached_at IS NULL
    JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
    JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    JOIN users principal ON principal.id=execution.company_execution_snapshot->'authority'->'actor'->>'id' AND principal.account_status='active' AND NOT principal.must_change_password
    WHERE execution.id=NEW.company_run_id AND execution.company_id=NEW.company_id AND execution.project_id IS NULL AND execution.run_kind='agent'
      AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking')
      AND assignment.status NOT IN ('completed','failed','cancelled')
      AND assignment.id=execution.company_execution_snapshot->'assignment'->>'id'
      AND input.revision::numeric=(execution.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND input.digest=execution.company_execution_snapshot->'assignment'->>'inputSha256'
      AND binding.id=execution.company_execution_snapshot->'specialistBinding'->>'id'
      AND binding.revision::numeric=(execution.company_execution_snapshot->'specialistBinding'->>'revision')::numeric
      AND configuration.snapshot_digest=execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'
      AND package.resolved_revision=configuration.snapshot->>'packageRevision'
      AND NEW.agent_id=binding.agent_id AND NEW.agent_id=execution.source_agent_id AND NEW.owner_user_id=principal.id
      AND NEW.scopes <@ (configuration.snapshot->'grantActions')
      AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:read' AND g.revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:update' AND g.revoked_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Company run credentials require the current exact owned execution, input, configuration and initiating authority'
      USING ERRCODE='23514', CONSTRAINT='project_tokens_company_reference_check';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_tokens_company_binding_guard BEFORE INSERT OR UPDATE ON project_tokens
FOR EACH ROW EXECUTE FUNCTION guard_company_agent_credential();
