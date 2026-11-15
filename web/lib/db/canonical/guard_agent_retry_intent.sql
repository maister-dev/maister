CREATE OR REPLACE FUNCTION public.guard_agent_retry_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('accepted','launched') OR
       (OLD.allocation IS NOT NULL AND OLD.allocation->>'disposition' <> 'released') THEN
      RAISE EXCEPTION 'retry intent retains admission or disposal evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_evidence_protected';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.company_id, NEW.project_id, NEW.source_agent_id, NEW.source_run_id,
         NEW.actor_identity, NEW.request_key, NEW.request_digest,
         NEW.selected_runner_id, NEW.recipe, NEW.preview_fingerprint, NEW.successor_run_id)
     IS DISTINCT FROM
     ROW(OLD.company_id, OLD.project_id, OLD.source_agent_id, OLD.source_run_id,
         OLD.actor_identity, OLD.request_key, OLD.request_digest,
         OLD.selected_runner_id, OLD.recipe, OLD.preview_fingerprint, OLD.successor_run_id) THEN
    RAISE EXCEPTION 'accepted retry recipe is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_recipe_immutable';
  END IF;
  IF NEW.lease_fence < OLD.lease_fence OR
     (OLD.state IN ('launched','refused') AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'retry ownership or receipt cannot move backwards'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_retry_receipt_monotonic';
  END IF;
  RETURN NEW;
END;
$function$;
