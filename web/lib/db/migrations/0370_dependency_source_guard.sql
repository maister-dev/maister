CREATE FUNCTION project_dependency_safe_source(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT length(value) BETWEEN 1 AND 4096 AND value !~ '[[:cntrl:]]'
    AND (left(value,1)='/' OR (
      value !~ '[?#]' AND value !~ '[[:space:]]' AND position(chr(92) in value)=0 AND (
        value ~ '^https?://[^/@:]+(:[0-9]+)?(/|$)' OR
        value ~ '^https?://\[[0-9a-fA-F:]+\](:[0-9]+)?(/|$)' OR
        value ~ '^file://(localhost)?/' OR
        value ~ '^ssh://([a-zA-Z0-9._-]+@)?([^/@:]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?(/|$)' OR
        (value ~ '^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*@[a-zA-Z0-9_.][a-zA-Z0-9_.-]*:.+$' AND position('::' in value)=0)
      )
    ));
$$;
--> statement-breakpoint
DO $$
DECLARE unsafe record;
BEGIN
  SELECT d.project_id, d.id, d.effective_attachment_id INTO unsafe
  FROM project_dependency_declarations d
  WHERE project_dependency_safe_source(d.desired->>'source') IS NOT TRUE
     OR EXISTS (SELECT 1 FROM project_dependency_attempts a WHERE a.declaration_id=d.id
                AND project_dependency_safe_source(a.desired->>'source') IS NOT TRUE)
  ORDER BY d.project_id,d.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Repair unsafe dependency in project %, declaration %, attachment %',
      unsafe.project_id, unsafe.id, unsafe.effective_attachment_id USING ERRCODE='23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_dependency_guard_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF project_dependency_safe_source(NEW.desired->>'source') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid dependency source for project %', NEW.project_id USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_dependency_source_before_write BEFORE INSERT OR UPDATE OF desired ON project_dependency_declarations
FOR EACH ROW EXECUTE FUNCTION project_dependency_guard_source();
