CREATE OR REPLACE FUNCTION public.guard_execution_host_registry_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  new_secondary boolean := false;
BEGIN
  IF current_setting('maister.execution_host_registry_writer', true) IS DISTINCT FROM 'v2' THEN
    IF TG_TABLE_NAME = 'execution_hosts' AND TG_OP <> 'DELETE' THEN
      new_secondary := NEW.transport->>'role' = 'secondary';
    END IF;
    IF new_secondary OR EXISTS (
      SELECT 1 FROM execution_hosts h
      WHERE h.transport->>'role' = 'secondary' AND (
        h.retired_at IS NULL OR
        EXISTS (SELECT 1 FROM execution_assignments a WHERE a.execution_host_id = h.id AND a.state = 'active') OR
        EXISTS (SELECT 1 FROM workspaces w WHERE w.execution_host_id = h.id AND w.removed_at IS NULL)
      )
    ) THEN
      RAISE EXCEPTION 'Execution host registry writer must support selected peers';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
