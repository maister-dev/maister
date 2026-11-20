-- Allow an active or previously rotated installation credential to record terminal revocation once.
CREATE OR REPLACE FUNCTION guard_installation_agent_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.installation_run_id IS DISTINCT FROM OLD.installation_run_id OR (
        OLD.installation_run_id IS NOT NULL AND (
          (to_jsonb(NEW) - 'last_used_at' - 'revoked_at' - 'owner_user_id' - 'revocation_reason')
          IS DISTINCT FROM (to_jsonb(OLD) - 'last_used_at' - 'revoked_at' - 'owner_user_id' - 'revocation_reason')
          OR (NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
          OR (NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason AND (
            OLD.revocation_reason IS NOT NULL OR NEW.revocation_reason IS DISTINCT FROM 'revoked'
            OR NEW.revoked_at IS NULL))
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL))) THEN
      RAISE EXCEPTION 'Installation Run credentials cannot be retargeted, widened or reactivated'
        USING ERRCODE='23514', CONSTRAINT='project_tokens_installation_binding_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.installation_run_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM agent_installation_run_authorities authority WHERE run_id=NEW.company_run_id) THEN
      RAISE EXCEPTION 'The installation Run requires its dedicated credential'
        USING ERRCODE='23514', CONSTRAINT='project_tokens_installation_reference_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM agent_installation_run_authorities authority
    JOIN runs execution ON execution.id=authority.run_id AND execution.project_id IS NULL
      AND execution.company_id=NEW.company_id AND execution.source_agent_id=NEW.agent_id
    JOIN company_specialist_bindings binding ON (binding.id,binding.revision)=(authority.binding_id,authority.binding_revision)
      AND (binding.company_id,binding.agent_id)=(execution.company_id,execution.source_agent_id)
      AND binding.enabled AND binding.detached_at IS NULL
    JOIN company_specialist_binding_revisions reviewed
      ON (reviewed.binding_id,reviewed.revision,reviewed.snapshot_digest)=(binding.id,binding.revision,authority.binding_digest)
    JOIN specialist_run_links link ON link.run_id=execution.id AND link.work_id IS NULL
      AND specialist_run_has_input(execution.id,link.assignment_id,link.input_revision,
        execution.company_execution_snapshot->'assignment'->>'inputSha256')
    WHERE execution.id=NEW.installation_run_id AND execution.id=NEW.company_run_id
      AND execution.run_kind='agent' AND execution.agent_workspace='none' AND execution.parent_run_id IS NULL
      AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review')
      AND execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'=reviewed.snapshot_digest
      AND authority.grant_snapshot=reviewed.snapshot->'installationGrant'
      AND NEW.scopes <@ (authority.grant_snapshot->'scopes')
      AND (
        (authority.principal->>'kind'='manual' AND execution.trigger_source='manual'
          AND NEW.owner_user_id=authority.principal->>'userId' AND NEW.owner_user_id=execution.created_by_user_id
          AND EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND account_status='active' AND NOT must_change_password))
        OR (authority.principal->>'kind'='unattended' AND execution.trigger_source=authority.principal->>'trigger'
          AND NEW.owner_user_id IS NULL AND execution.agent_schedule_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'Installation credentials require the exact current agent grant and execution'
      USING ERRCODE='23514', CONSTRAINT='project_tokens_installation_reference_check';
  END IF;
  RETURN NEW;
END;
$$;
