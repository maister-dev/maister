CREATE OR REPLACE FUNCTION public.guard_human_work_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  owner_project text;
  owner_company text;
  owner_run text;
  referenced_actor text;
BEGIN
  IF TG_TABLE_NAME = 'actor_identities' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (OLD.project_id,OLD.company_id) IS DISTINCT FROM (NEW.project_id,NEW.company_id) THEN
        RAISE EXCEPTION 'Human actor owner is immutable' USING ERRCODE='23514',CONSTRAINT='human_actor_owner_immutable';
      END IF;
      IF OLD.company_id IS NOT NULL AND (
        OLD.kind IS DISTINCT FROM NEW.kind OR OLD.token_id IS DISTINCT FROM NEW.token_id OR
        OLD.internal_agent_ref IS DISTINCT FROM NEW.internal_agent_ref OR OLD.system_key IS DISTINCT FROM NEW.system_key OR
        (OLD.user_id IS DISTINCT FROM NEW.user_id AND (NEW.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id)))
      ) THEN
        RAISE EXCEPTION 'Company actor principal is immutable' USING ERRCODE='23514',CONSTRAINT='human_actor_principal_immutable';
      END IF;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.company_id IS NOT NULL AND NEW.kind='user' AND NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'A company user actor requires its server principal' USING ERRCODE='23514',CONSTRAINT='human_actor_principal_required';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'assignments' THEN
    IF TG_OP = 'UPDATE' AND (OLD.project_id,OLD.company_id,OLD.run_id,OLD.hitl_request_id)
      IS DISTINCT FROM (NEW.project_id,NEW.company_id,NEW.run_id,NEW.hitl_request_id) THEN
      RAISE EXCEPTION 'Human work owner and source are immutable' USING ERRCODE='23514',CONSTRAINT='human_assignment_owner_immutable';
    END IF;
    SELECT project_id,company_id INTO owner_project,owner_company FROM runs WHERE id=NEW.run_id FOR KEY SHARE;
    IF NOT FOUND OR (owner_project,owner_company) IS DISTINCT FROM (NEW.project_id,NEW.company_id) THEN
      RAISE EXCEPTION 'Human work requires its retained Run owner' USING ERRCODE='23514',CONSTRAINT='human_assignment_run_owner';
    END IF;
    IF NEW.hitl_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM hitl_requests WHERE id=NEW.hitl_request_id AND run_id=NEW.run_id
    ) THEN
      RAISE EXCEPTION 'Human work requires its owned HITL source' USING ERRCODE='23514',CONSTRAINT='human_assignment_hitl_owner';
    END IF;
    FOREACH referenced_actor IN ARRAY ARRAY[NEW.assignee_actor_id,NEW.created_by_actor_id,NEW.completed_by_actor_id] LOOP
      IF referenced_actor IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM actor_identities WHERE id=referenced_actor
          AND project_id IS NOT DISTINCT FROM NEW.project_id AND company_id IS NOT DISTINCT FROM NEW.company_id
      ) THEN
        RAISE EXCEPTION 'Human work actor belongs to another owner' USING ERRCODE='23514',CONSTRAINT='human_assignment_actor_owner';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.assignment_id,OLD.project_id,OLD.company_id,OLD.run_id)
    IS DISTINCT FROM (NEW.assignment_id,NEW.project_id,NEW.company_id,NEW.run_id) THEN
    RAISE EXCEPTION 'Human work event owner is immutable' USING ERRCODE='23514',CONSTRAINT='human_assignment_event_immutable';
  END IF;
  SELECT project_id,company_id,run_id INTO owner_project,owner_company,owner_run FROM assignments WHERE id=NEW.assignment_id FOR KEY SHARE;
  IF NOT FOUND OR (owner_project,owner_company,owner_run) IS DISTINCT FROM (NEW.project_id,NEW.company_id,NEW.run_id) THEN
    RAISE EXCEPTION 'Human work event requires its assignment owner and Run' USING ERRCODE='23514',CONSTRAINT='human_assignment_event_owner';
  END IF;
  IF NEW.actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM actor_identities WHERE id=NEW.actor_id AND project_id IS NOT DISTINCT FROM NEW.project_id AND company_id IS NOT DISTINCT FROM NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Human work event actor belongs to another owner' USING ERRCODE='23514',CONSTRAINT='human_assignment_event_actor_owner';
  END IF;
  RETURN NEW;
END;
$function$;
