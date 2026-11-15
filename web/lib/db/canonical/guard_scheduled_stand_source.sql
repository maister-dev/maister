CREATE OR REPLACE FUNCTION public.guard_scheduled_stand_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.stand_inspection IS DISTINCT FROM OLD.stand_inspection
      OR (OLD.stand_inspection IS NOT NULL AND
        (NEW.agent_id,NEW.company_specialist_binding_id,NEW.company_flow_binding_id,NEW.trigger_type)
          IS DISTINCT FROM
        (OLD.agent_id,OLD.company_specialist_binding_id,OLD.company_flow_binding_id,OLD.trigger_type)) THEN
      RAISE EXCEPTION 'Scheduled stand appointment is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.stand_inspection IS NOT NULL AND (
    NEW.company_id IS NULL OR NEW.project_id IS NOT NULL OR NEW.trigger_type<>'cron' OR NEW.company_flow_binding_id IS NOT NULL
    OR jsonb_typeof(NEW.stand_inspection) IS DISTINCT FROM 'object'
    OR NEW.stand_inspection-ARRAY['targetId','componentId','configRevision','incarnationId']<>'{}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM stand_targets target JOIN stand_components part
        ON part.target_id=target.id AND part.config_revision=target.config_revision
      WHERE target.id=NEW.stand_inspection->>'targetId' AND target.company_id=NEW.company_id
        AND target.enabled AND to_jsonb(target.config_revision)=NEW.stand_inspection->'configRevision'
        AND target.incarnation_id=NEW.stand_inspection->>'incarnationId'
        AND part.component_id=NEW.stand_inspection->>'componentId' AND part.config->'actions' ? 'inspect'
    )
  ) THEN
    RAISE EXCEPTION 'Scheduled stand appointment requires the exact enabled company component' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
