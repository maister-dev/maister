CREATE OR REPLACE FUNCTION public.agent_memory_require_revision_payload()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.content_sha256 IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_memory_revision_payloads
    WHERE (vault_id, note_id, revision_id) = (NEW.vault_id, NEW.note_id, NEW.id)
  ) AND NOT EXISTS (
    SELECT 1 FROM agent_memory_redactions
    WHERE (vault_id, note_id, revision_id) = (NEW.vault_id, NEW.note_id, NEW.id)
  ) THEN
    RAISE EXCEPTION 'Agent memory revision is missing its payload'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_revision_payload_required';
  END IF;
  RETURN NULL;
END;
$function$;
