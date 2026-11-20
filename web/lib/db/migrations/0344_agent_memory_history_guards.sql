UPDATE runs SET agent_memory_hash_format = 'legacy-file-v1'
WHERE agent_memory_hash IS NOT NULL AND agent_memory_hash_format IS NULL;
--> statement-breakpoint
ALTER TABLE agent_memory_notes ADD CONSTRAINT agent_memory_note_head_fk
  FOREIGN KEY (vault_id, id, head_revision_id)
  REFERENCES agent_memory_revisions(vault_id, note_id, id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION agent_memory_immutable_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent memory history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_immutable_history';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_memory_revision_immutable
BEFORE UPDATE OR DELETE ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION agent_memory_immutable_history();
--> statement-breakpoint
CREATE TRIGGER agent_memory_redaction_immutable
BEFORE UPDATE OR DELETE ON agent_memory_redactions
FOR EACH ROW EXECUTE FUNCTION agent_memory_immutable_history();
--> statement-breakpoint
CREATE TRIGGER agent_memory_import_payload_immutable
BEFORE UPDATE OR DELETE ON agent_memory_import_payloads
FOR EACH ROW EXECUTE FUNCTION agent_memory_immutable_history();
--> statement-breakpoint
CREATE FUNCTION agent_memory_guard_note_head() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER agent_memory_note_head_projection
AFTER INSERT OR UPDATE ON agent_memory_notes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agent_memory_guard_note_head();
--> statement-breakpoint
CREATE FUNCTION agent_memory_guard_payload() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE TRIGGER agent_memory_payload_guard
BEFORE INSERT OR UPDATE OR DELETE ON agent_memory_revision_payloads
FOR EACH ROW EXECUTE FUNCTION agent_memory_guard_payload();
--> statement-breakpoint
CREATE FUNCTION agent_memory_require_revision_payload() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER agent_memory_revision_payload_required
AFTER INSERT ON agent_memory_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agent_memory_require_revision_payload();
--> statement-breakpoint
CREATE FUNCTION agent_memory_require_redaction_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.administrator_id AND role = 'admin' AND account_status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent memory redaction requires a current administrator'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_redaction_admin_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_memory_redaction_admin_required
BEFORE INSERT ON agent_memory_redactions
FOR EACH ROW EXECUTE FUNCTION agent_memory_require_redaction_admin();
--> statement-breakpoint
CREATE FUNCTION agent_memory_require_redaction_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER agent_memory_redaction_effect_required
AFTER INSERT ON agent_memory_redactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION agent_memory_require_redaction_effect();
--> statement-breakpoint
CREATE FUNCTION agent_memory_set_hash_format() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_memory_hash IS NULL THEN
    NEW.agent_memory_hash_format := NULL;
    RETURN NEW;
  END IF;
  IF NEW.agent_memory_hash_format IS NULL THEN
    IF EXISTS (SELECT 1 FROM agent_memory_cutover) THEN
      RAISE EXCEPTION 'Use the activated agent memory vault writer'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_run_writer_required';
    END IF;
    NEW.agent_memory_hash_format := 'legacy-file-v1';
  END IF;
  IF NEW.agent_memory_hash_format NOT IN ('legacy-file-v1', 'vault-manifest-v1') THEN
    RAISE EXCEPTION 'Agent memory hash format is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_run_hash_format';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_memory_run_hash_format
BEFORE INSERT OR UPDATE OF agent_memory_hash, agent_memory_hash_format ON runs
FOR EACH ROW EXECUTE FUNCTION agent_memory_set_hash_format();
