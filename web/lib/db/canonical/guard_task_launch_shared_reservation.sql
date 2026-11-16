CREATE OR REPLACE FUNCTION public.guard_task_launch_shared_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    IF NEW.task_id IS NULL OR NEW.run_kind NOT IN ('flow', 'agent')
      OR NEW.agent_kind = 'operational' OR NEW.task_launch_intent_id IS NOT NULL
      OR NEW.status NOT IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      -- Same-run continuation keeps its historical receipt and reservation.
      -- Re-entering after release must compete with a newly accepted request.
      IF OLD.task_id IS NOT DISTINCT FROM NEW.task_id
        AND OLD.run_kind IN ('flow', 'agent')
        AND OLD.agent_kind IS DISTINCT FROM 'operational'
        AND OLD.task_launch_intent_id IS NULL
        AND OLD.status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren') THEN
        RETURN NEW;
      END IF;
    END IF;

    IF NEW.task_admission_snapshot->'version'='3'::jsonb THEN
      PERFORM assert_task_consensus_child_scope(NEW);
      RETURN NEW;
    END IF;

    PERFORM id FROM tasks WHERE id = NEW.task_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM task_launch_intents
      WHERE task_id = NEW.task_id
        AND state IN ('queued', 'preparing', 'run_bound', 'held')
    ) THEN
      RAISE EXCEPTION 'Task delivery is already reserved by an accepted launch request'
        USING ERRCODE = '23514', CONSTRAINT = 'task_launch_shared_reservation';
    END IF;
  ELSE
    IF NEW.reservation_lane <> 'ordinary'
      OR NEW.state NOT IN ('queued', 'preparing', 'run_bound', 'held') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.task_id IS NOT DISTINCT FROM NEW.task_id
        AND OLD.reservation_lane = 'ordinary'
        AND OLD.state IN ('queued', 'preparing', 'run_bound', 'held') THEN
        RETURN NEW;
      END IF;
    END IF;

    PERFORM id FROM tasks WHERE id = NEW.task_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM task_launch_intents WHERE task_id=NEW.task_id AND id<>NEW.id
      AND state IN ('queued','preparing','run_bound','held')) THEN
      RAISE EXCEPTION 'Ordinary delivery waits for the existing explicit delivery request'
        USING ERRCODE='23514',CONSTRAINT='task_launch_shared_reservation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM runs
      WHERE task_id = NEW.task_id AND task_launch_intent_id IS NULL
        AND run_kind IN ('flow', 'agent') AND agent_kind IS DISTINCT FROM 'operational'
        AND (task_admission_snapshot->'version'='3'::jsonb AND task_admission_snapshot->>'mode'='execution_child'
          AND task_admission_snapshot->>'scope'='consensus_draft') IS DISTINCT FROM TRUE
        AND status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren')
    ) THEN
      RAISE EXCEPTION 'Task delivery is already reserved by a historical admission run'
        USING ERRCODE = '23514', CONSTRAINT = 'task_launch_shared_reservation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
