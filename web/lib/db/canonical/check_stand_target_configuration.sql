CREATE OR REPLACE FUNCTION public.check_stand_target_configuration()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stand_target_revisions revision
    WHERE revision.target_id=NEW.id AND revision.revision=NEW.config_revision AND revision.enabled=NEW.enabled
      AND revision.authority->>'kind'='company_grant'
      AND revision.authority->'owner'->>'companyId'=NEW.company_id
      AND revision.authority->>'action'='targets:manage'
      AND jsonb_array_length(revision.component_ids)=(SELECT count(*) FROM stand_components component WHERE component.target_id=revision.target_id AND component.config_revision=revision.revision)
  ) THEN
    RAISE EXCEPTION 'Stand head requires its complete reviewed configuration' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
