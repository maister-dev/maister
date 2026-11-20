CREATE OR REPLACE FUNCTION public.agent_memory_guard_note_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  revision_parent text;
  revision_kind text;
  revision_path text;
BEGIN
  SELECT parent_revision_id, kind, path
  INTO revision_parent, revision_kind, revision_path
  FROM agent_memory_revisions
  WHERE (vault_id, note_id, id) = (NEW.vault_id, NEW.id, NEW.head_revision_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent memory head must refer to the same vault and note'
      USING ERRCODE = '23503', CONSTRAINT = 'agent_memory_note_head_fk';
  END IF;
  IF NEW.path IS DISTINCT FROM revision_path OR
    (NEW.deleted_at IS NOT NULL) IS DISTINCT FROM (revision_kind IN ('deleted', 'redacted')) THEN
    RAISE EXCEPTION 'Agent memory head projection must match its revision'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_note_head_projection';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.vault_id, NEW.id) IS DISTINCT FROM (OLD.vault_id, OLD.id) OR
      (NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id
        AND revision_parent IS DISTINCT FROM OLD.head_revision_id) THEN
      RAISE EXCEPTION 'Agent memory head can advance to its successor only'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_note_head_progress';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
