CREATE OR REPLACE FUNCTION public.guard_agent_schedule_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE role company_specialist_bindings;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.company_id IS NOT NULL THEN
      RAISE EXCEPTION 'Disable a company source while retaining its creation receipt and invocation identity' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.project_id,NEW.company_id,NEW.created_by,NEW.creation_key,NEW.creation_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.company_id,OLD.created_by,OLD.creation_key,OLD.creation_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'Agent schedule ownership and original creation receipt are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.company_id IS NOT NULL THEN
    IF TG_OP='INSERT' AND NEW.company_config_revision<>1 THEN
      RAISE EXCEPTION 'Company source configuration starts at revision one' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' THEN
      IF (NEW.agent_id,NEW.company_specialist_binding_id,NEW.company_flow_binding_id,NEW.trigger_type,NEW.request_at_launch,NEW.cron_expr,NEW.timezone,NEW.event_match,NEW.enabled)
        IS DISTINCT FROM (OLD.agent_id,OLD.company_specialist_binding_id,OLD.company_flow_binding_id,OLD.trigger_type,OLD.request_at_launch,OLD.cron_expr,OLD.timezone,OLD.event_match,OLD.enabled) THEN
        IF NEW.company_config_revision<>OLD.company_config_revision+1 THEN
          RAISE EXCEPTION 'Company source input changes require one configuration revision; telemetry has its own fence' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.company_config_revision IS DISTINCT FROM OLD.company_config_revision THEN
        RAISE EXCEPTION 'Company source telemetry cannot advance configuration revision' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT * INTO role FROM company_specialist_bindings WHERE id=NEW.company_specialist_binding_id;
    IF role.id IS NULL OR role.company_id IS DISTINCT FROM NEW.company_id OR role.agent_id IS DISTINCT FROM NEW.agent_id THEN
      RAISE EXCEPTION 'Company source specialist must match its explicit company and professional role' USING ERRCODE='23514';
    END IF;
    IF NEW.company_flow_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_flow_bindings f WHERE f.id=NEW.company_flow_binding_id AND f.company_id=NEW.company_id) THEN
      RAISE EXCEPTION 'Company source coordinator must have the same owner' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
