-- Custom SQL migration file, put your code below! --
CREATE FUNCTION guard_stand_effect_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect_state<>OLD.effect_state AND NOT (
    (OLD.effect_state='not_dispatched' AND NEW.effect_state='dispatching')
    OR (OLD.effect_state='dispatching' AND NEW.effect_state IN ('unknown','confirmed_applied','confirmed_not_applied'))
    OR (OLD.effect_state='unknown' AND NEW.effect_state IN ('confirmed_applied','confirmed_not_applied'))
  ) THEN
    RAISE EXCEPTION 'Stand effect transition requires a retained dispatch or reconciliation' USING ERRCODE='23514';
  END IF;
  IF NOT (
    (NEW.effect_state IN ('not_dispatched','dispatching') AND NEW.disposition='pending')
    OR (NEW.effect_state='unknown' AND NEW.disposition IN ('pending','unresolved_hold','authorized_successor'))
    OR (NEW.effect_state='confirmed_applied' AND NEW.disposition='proved_applied')
    OR (NEW.effect_state='confirmed_not_applied' AND NEW.disposition='proved_not_applied')
  ) THEN
    RAISE EXCEPTION 'Stand recovery disposition must match the retained effect state' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_effect_transition_guard BEFORE UPDATE ON stand_operations FOR EACH ROW EXECUTE FUNCTION guard_stand_effect_transition();
