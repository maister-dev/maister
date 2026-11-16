CREATE FUNCTION guard_stand_operation() RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE TRIGGER stand_operation_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON stand_operations FOR EACH ROW EXECUTE FUNCTION guard_stand_operation();
--> statement-breakpoint
CREATE FUNCTION guard_stand_resource_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.unresolved THEN
      RAISE EXCEPTION 'An unresolved stand resource claim cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation WHERE operation.id=NEW.operation_id
      AND operation.resource_key=NEW.canonical_resource_key AND operation.action='restart'
      AND (NEW.unresolved OR operation.effect_state IN ('confirmed_applied','confirmed_not_applied'))
  ) THEN
    RAISE EXCEPTION 'Stand resource claim must name an exact restart and retain unresolved effects' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.canonical_resource_key<>OLD.canonical_resource_key OR NEW.owner_epoch<OLD.owner_epoch
    OR ((NEW.owner_id,NEW.operation_id) IS DISTINCT FROM (OLD.owner_id,OLD.operation_id) AND NEW.owner_epoch<=OLD.owner_epoch)
    OR (OLD.unresolved AND NEW.operation_id<>OLD.operation_id AND NOT EXISTS (
      SELECT 1 FROM stand_operations successor JOIN stand_operations predecessor ON predecessor.id=successor.predecessor_id
      WHERE successor.id=NEW.operation_id AND predecessor.id=OLD.operation_id
        AND predecessor.effect_state='unknown' AND predecessor.disposition='authorized_successor'
    ))
  ) THEN
    RAISE EXCEPTION 'Stand claim ownership changes require a higher epoch on the same resource' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_resource_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON stand_resource_claims FOR EACH ROW EXECUTE FUNCTION guard_stand_resource_claim();
--> statement-breakpoint
CREATE FUNCTION check_stand_restart_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='restart' AND NOT EXISTS (
    SELECT 1 FROM stand_resource_claims claim WHERE claim.operation_id=NEW.id
      AND claim.canonical_resource_key=NEW.resource_key AND claim.unresolved
  ) THEN
    RAISE EXCEPTION 'A stand restart intent requires its resource exclusion' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stand_restart_claim_check AFTER INSERT ON stand_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stand_restart_claim();
