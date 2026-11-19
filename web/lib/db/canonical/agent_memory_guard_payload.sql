CREATE OR REPLACE FUNCTION public.agent_memory_guard_payload()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  expected_hash text;
  expected_bytes integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM agent_memory_redactions
      WHERE (vault_id, note_id, revision_id) = (OLD.vault_id, OLD.note_id, OLD.revision_id)
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Agent memory payload removal requires redaction'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_payload_redaction_required';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Agent memory payload is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_payload_immutable';
  END IF;
  SELECT content_sha256, size_bytes INTO expected_hash, expected_bytes
  FROM agent_memory_revisions
  WHERE (vault_id, note_id, id) = (NEW.vault_id, NEW.note_id, NEW.revision_id);
  IF expected_hash IS NULL OR
    expected_hash <> encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') OR
    expected_bytes <> octet_length(NEW.content) OR EXISTS (
      SELECT 1 FROM agent_memory_redactions
      WHERE (vault_id, note_id, revision_id) = (NEW.vault_id, NEW.note_id, NEW.revision_id)
    ) THEN
    RAISE EXCEPTION 'Agent memory payload must match a nonredacted content revision'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_payload_identity';
  END IF;
  RETURN NEW;
END;
$function$;
