CREATE OR REPLACE FUNCTION public.guard_installation_schedule_review()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE review jsonb := NEW.installation_review;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.installation_review IS DISTINCT FROM review THEN
      RAISE EXCEPTION 'Installation schedule review is immutable' USING ERRCODE='23514',CONSTRAINT='agent_schedules_installation_review_check';
    END IF;
    RETURN NEW;
  END IF;
  IF review IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM company_specialist_bindings binding
    JOIN company_specialist_binding_revisions revision ON (revision.binding_id,revision.revision)=(binding.id,binding.revision)
    JOIN users reviewer ON reviewer.id=NEW.created_by AND reviewer.account_status='active' AND NOT reviewer.must_change_password
    JOIN company_grants grant_row ON grant_row.company_id=NEW.company_id AND grant_row.principal_type='user'
      AND grant_row.principal_id=reviewer.id AND grant_row.action='assignments:update' AND grant_row.revoked_at IS NULL
    WHERE binding.id=NEW.company_specialist_binding_id AND binding.company_id=NEW.company_id AND binding.agent_id=NEW.agent_id
      AND NEW.project_id IS NULL AND NEW.company_flow_binding_id IS NULL AND NEW.stand_inspection IS NULL
      AND NEW.company_config_revision=1 AND NEW.enabled AND binding.enabled AND binding.detached_at IS NULL
      AND revision.snapshot ? 'installationGrant'
      AND review=jsonb_build_object('schemaVersion',1,
        'binding',jsonb_build_object('id',binding.id,'revision',binding.revision,'snapshotSha256',revision.snapshot_digest),
        'reviewer',jsonb_build_object(
          'actor',jsonb_build_object('kind','user','id',reviewer.id,'runId',NULL,'attemptId',NULL),
          'witness',jsonb_build_object('kind','company_grant','owner',jsonb_build_object('kind','company','companyId',NEW.company_id),
            'authorityId',grant_row.id,'revision',grant_row.revision,'action','assignments:update')))
    FOR SHARE OF binding,revision,reviewer,grant_row
  ) THEN
    RAISE EXCEPTION 'Installation schedule requires its exact reviewed binding and source authority' USING ERRCODE='23514',CONSTRAINT='agent_schedules_installation_review_check';
  END IF;
  RETURN NEW;
END;
$function$;
