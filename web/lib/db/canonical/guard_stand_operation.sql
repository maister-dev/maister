CREATE OR REPLACE FUNCTION public.guard_stand_operation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Stand operation history cannot be removed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.effect_state<>'not_dispatched' OR NEW.verification_state<>'not_checked' OR NEW.disposition<>'pending' OR NOT EXISTS (
      SELECT 1 FROM specialist_assignments subject
      JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=NEW.input_revision
      JOIN stand_targets target ON target.id=NEW.target_id AND target.config_revision=NEW.config_revision AND target.enabled
      JOIN stand_components component ON component.target_id=target.id AND component.config_revision=target.config_revision AND component.component_id=NEW.component_id
      WHERE subject.id=NEW.assignment_id AND subject.input_revision=NEW.input_revision AND subject.revision=NEW.assignment_revision
        AND subject.status NOT IN ('completed','failed','cancelled')
        AND (subject.company_id=target.company_id OR subject.project_id IS NOT NULL)
        AND input.digest=NEW.input_sha256 AND input.objective_input->'targetIds' ? target.id
        AND target.incarnation_id=NEW.target_incarnation AND component.canonical_resource_key=NEW.resource_key
        AND component.config->'actions' ? NEW.action
    ) THEN
      RAISE EXCEPTION 'Stand operation requires exact current appointment, target and authorized component policy' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['effect_state','verification_state','disposition','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['effect_state','verification_state','disposition','revision'])
     OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Stand operation intent is immutable and outcome revisions advance once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
