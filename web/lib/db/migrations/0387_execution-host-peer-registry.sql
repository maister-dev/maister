DROP INDEX "execution_hosts_local_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "execution_hosts_local_active_uq" ON "execution_hosts" USING btree ("kind") WHERE "execution_hosts"."kind" = 'local_direct' AND "execution_hosts"."retired_at" IS NULL AND coalesce("execution_hosts"."transport"->>'role', 'default') = 'default';--> statement-breakpoint
CREATE FUNCTION "guard_execution_host_registry_writer"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;--> statement-breakpoint
CREATE TRIGGER "execution_hosts_registry_writer"
BEFORE INSERT OR UPDATE OF host_key, kind, display_name, transport, capabilities, readiness, readiness_reason, retired_at OR DELETE
ON "execution_hosts" FOR EACH ROW EXECUTE FUNCTION "guard_execution_host_registry_writer"();--> statement-breakpoint
CREATE TRIGGER "execution_assignments_registry_writer"
BEFORE INSERT ON "execution_assignments" FOR EACH ROW EXECUTE FUNCTION "guard_execution_host_registry_writer"();
