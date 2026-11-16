CREATE FUNCTION guard_stand_config_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Retained stand configuration is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_target_revision_immutable BEFORE UPDATE OR DELETE ON stand_target_revisions FOR EACH ROW EXECUTE FUNCTION guard_stand_config_history();
--> statement-breakpoint
CREATE TRIGGER stand_component_immutable BEFORE UPDATE OR DELETE ON stand_components FOR EACH ROW EXECUTE FUNCTION guard_stand_config_history();
--> statement-breakpoint
CREATE FUNCTION guard_stand_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head stand_targets;
BEGIN
  SELECT * INTO head FROM stand_targets WHERE id=NEW.target_id FOR NO KEY UPDATE;
  IF head.id IS NULL OR head.config_revision<>NEW.revision OR head.enabled<>NEW.enabled
     OR NEW.authority->'owner'->>'companyId' IS DISTINCT FROM head.company_id
     OR NEW.authority->>'action' IS DISTINCT FROM 'targets:manage' THEN
    RAISE EXCEPTION 'Stand revision must describe its exact owned head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_target_revision_insert_guard BEFORE INSERT ON stand_target_revisions FOR EACH ROW EXECUTE FUNCTION guard_stand_revision_insert();
--> statement-breakpoint
CREATE FUNCTION guard_stand_component_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stand_target_revisions revision
    WHERE revision.target_id=NEW.target_id AND revision.revision=NEW.config_revision
      AND revision.component_ids ? NEW.component_id
  ) THEN
    RAISE EXCEPTION 'Stand components must be retained with their original configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_component_insert_guard BEFORE INSERT ON stand_components FOR EACH ROW EXECUTE FUNCTION guard_stand_component_insert();
--> statement-breakpoint
CREATE FUNCTION guard_stand_target_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Disable the stand without deleting its retained identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.config_revision<>1 THEN
      RAISE EXCEPTION 'Stand configuration begins at revision one' USING ERRCODE='23514';
    END IF;
  ELSIF (NEW.id,NEW.company_id,NEW.incarnation_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.incarnation_id,OLD.created_at)
     OR NEW.config_revision<>OLD.config_revision+1 THEN
    RAISE EXCEPTION 'Stand identity is immutable and configuration revisions advance once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_target_head_guard BEFORE INSERT OR UPDATE OR DELETE ON stand_targets FOR EACH ROW EXECUTE FUNCTION guard_stand_target_head();
--> statement-breakpoint
CREATE FUNCTION check_stand_target_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stand_target_configuration_guard AFTER INSERT OR UPDATE ON stand_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stand_target_configuration();
