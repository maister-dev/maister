CREATE OR REPLACE FUNCTION public.agent_memory_require_redaction_effect()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_memory_revision_payloads
    WHERE (vault_id, note_id, revision_id) = (NEW.vault_id, NEW.note_id, NEW.revision_id)
  ) OR EXISTS (
    SELECT 1 FROM agent_memory_notes
    WHERE (vault_id, id, head_revision_id) = (NEW.vault_id, NEW.note_id, NEW.revision_id)
  ) THEN
    RAISE EXCEPTION 'Agent memory redaction must remove its payload and active head'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_redaction_effect_required';
  END IF;
  RETURN NULL;
END;
$function$;
