CREATE OR REPLACE FUNCTION public.check_company_specialist_binding_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE head company_specialist_bindings;
BEGIN
  SELECT * INTO head FROM company_specialist_bindings WHERE id=NEW.binding_id;
  IF head.id IS NULL OR NEW.revision<>head.revision OR
    (NEW.revision=1) IS DISTINCT FROM (NEW.operation='created') OR
    (NEW.revision=1 AND (NEW.request_actor_id,NEW.request_key,NEW.request_digest) IS DISTINCT FROM (head.created_by,head.creation_key,head.creation_digest)) OR
    NEW.snapshot->>'agentId' IS DISTINCT FROM head.agent_id OR
    NEW.authority_snapshot->'witness'->'owner'->>'companyId' IS DISTINCT FROM head.company_id OR
    NEW.authority_snapshot->'witness'->>'action' IS DISTINCT FROM 'specialists:manage' OR
    (NEW.snapshot->>'enabled')::boolean IS DISTINCT FROM head.enabled OR
    (NEW.snapshot->>'detachedAt')::timestamptz IS DISTINCT FROM head.detached_at OR
    (head.detached_at IS NOT NULL) IS DISTINCT FROM (NEW.operation='detached') OR
    (head.detached_at IS NULL AND NEW.snapshot->>'packageInstallId' IS DISTINCT FROM head.package_install_id) THEN
    RAISE EXCEPTION 'Company specialist revision must describe its exact owned head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
