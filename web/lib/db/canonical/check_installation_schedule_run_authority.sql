CREATE OR REPLACE FUNCTION public.check_installation_schedule_run_authority()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.company_id IS NOT NULL AND NEW.trigger_source IN ('cron','domain_event')
    AND NEW.retry_of_run_id IS NULL AND NEW.created_by_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_installation_run_authorities authority
      JOIN company_specialist_binding_revisions reviewed ON (reviewed.binding_id,reviewed.revision,reviewed.snapshot_digest)=
        (authority.binding_id,authority.binding_revision,authority.binding_digest)
      WHERE authority.run_id=NEW.id AND authority.principal=jsonb_build_object('kind','unattended','trigger',NEW.trigger_source)
        AND authority.grant_snapshot=reviewed.snapshot->'installationGrant'
        AND NEW.company_execution_snapshot->'specialistBinding'=jsonb_build_object('id',authority.binding_id,
          'revision',authority.binding_revision,'snapshotSha256',authority.binding_digest)
    )
  THEN
    RAISE EXCEPTION 'Installation trigger reservation requires its exact grant' USING ERRCODE='23514',CONSTRAINT='agent_installation_schedule_run_authority_check';
  END IF;
  RETURN NULL;
END;
$function$;
