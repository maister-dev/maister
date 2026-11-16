-- Server-derived source access, independent of model citations and project lifetime.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE brain_items ADD COLUMN source_restrictions jsonb CHECK (source_restrictions IS NULL OR (jsonb_typeof(source_restrictions)='array' AND jsonb_array_length(source_restrictions)<=256 AND pg_column_size(source_restrictions)<=65536));
ALTER TABLE brain_items ADD COLUMN source_acl_key text NOT NULL DEFAULT '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b';
CREATE FUNCTION brain_capture_source_acl_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.source_acl_key := encode(sha256(convert_to(coalesce(NEW.source_restrictions,'null'::jsonb)::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER brain_items_source_acl_key BEFORE INSERT OR UPDATE ON brain_items FOR EACH ROW EXECUTE FUNCTION brain_capture_source_acl_key();
ALTER TABLE brain_record_revisions ADD COLUMN source_restrictions jsonb CHECK (source_restrictions IS NULL OR (jsonb_typeof(source_restrictions)='array' AND jsonb_array_length(source_restrictions)<=256 AND pg_column_size(source_restrictions)<=65536));
ALTER TABLE brain_sources ADD COLUMN source_restrictions jsonb CHECK (source_restrictions IS NULL OR (jsonb_typeof(source_restrictions)='array' AND jsonb_array_length(source_restrictions)<=256 AND pg_column_size(source_restrictions)<=65536));
DROP INDEX brain_items_active_hash_uq;
DROP INDEX brain_items_company_active_hash_uq;
CREATE UNIQUE INDEX brain_items_active_hash_uq ON brain_items(project_id,content_hash,source_acl_key) WHERE status='active' AND visibility='owner_grants';
CREATE UNIQUE INDEX brain_items_company_active_hash_uq ON brain_items(company_id,content_hash,source_acl_key) WHERE company_id IS NOT NULL AND status='active' AND visibility='owner_grants';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION brain_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consistent boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM brain_items WHERE id=NEW.id) THEN RETURN NULL; END IF;
  SELECT (i.title=r.title AND i.content=r.assertion AND i.kind=r.kind AND i.source_restrictions IS NOT DISTINCT FROM r.source_restrictions) INTO consistent
  FROM brain_items i JOIN brain_record_revisions r ON r.record_id=i.id AND r.revision=i.current_revision
  WHERE i.id=NEW.id;
  IF consistent IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Knowledge head must match its immutable revision' USING ERRCODE='23514', CONSTRAINT='brain_record_head_matches_revision';
  END IF;
  IF EXISTS (SELECT 1 FROM brain_items i JOIN brain_record_grants g ON g.record_id=i.id WHERE i.id=NEW.id AND i.visibility='owner_grants' AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Narrower record grants require a restricted projection' USING ERRCODE='23514', CONSTRAINT='brain_record_grants_require_restriction';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION brain_capture_legacy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('maister.knowledge_writer',true) = 'native_v1' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.current_revision=OLD.current_revision THEN RETURN NULL; END IF;
  INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance,source_restrictions)
  VALUES (NEW.id,NEW.current_revision,NEW.content,NEW.title,NEW.kind,'unknown',encode(sha256(convert_to(NEW.content,'UTF8')),'hex'),
    jsonb_build_object('kind','legacy_unknown','id',NULL,'runId',NEW.source_run_id,'attemptId',NEW.source_node_attempt_id),
    jsonb_build_object('state','unknown','applicability','unknown','observedAt',NULL,'sourceAt',NULL,'capturedAt',now()),
    '["Legacy writer metadata does not establish submitting identity, observation time or confirmation."]'::jsonb,'legacy_writer',NEW.source_restrictions);
  RETURN NULL;
END $$;

--> statement-breakpoint
CREATE TABLE brain_source_submissions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  principal_key text NOT NULL,
  delivery_key text NOT NULL CHECK (length(delivery_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  source_id text NOT NULL,
  witness_id text NOT NULL REFERENCES brain_evidence_witnesses(id) ON DELETE CASCADE,
  attribution jsonb NOT NULL CHECK (jsonb_typeof(attribution)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((project_id IS NULL) <> (company_id IS NULL))
);
CREATE UNIQUE INDEX brain_source_submissions_project_delivery_uq ON brain_source_submissions(project_id,principal_key,delivery_key) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX brain_source_submissions_company_delivery_uq ON brain_source_submissions(company_id,principal_key,delivery_key) WHERE company_id IS NOT NULL;
CREATE TRIGGER brain_source_submissions_immutable BEFORE UPDATE OR DELETE ON brain_source_submissions FOR EACH ROW EXECUTE FUNCTION brain_guard_submission_history();
CREATE FUNCTION brain_check_source_submission_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE witness_project text; witness_company text; witness_source text;
BEGIN
  SELECT o.project_id,o.company_id,o.source_id INTO witness_project,witness_company,witness_source FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id WHERE w.id=NEW.witness_id;
  IF FOUND AND (witness_project IS DISTINCT FROM NEW.project_id OR witness_company IS DISTINCT FROM NEW.company_id OR witness_source IS DISTINCT FROM NEW.source_id) THEN
    RAISE EXCEPTION 'Source submission and capture must have the same lifetime owner and source' USING ERRCODE='23514', CONSTRAINT='brain_source_submission_owner_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_source_submissions_owner BEFORE INSERT ON brain_source_submissions FOR EACH ROW EXECUTE FUNCTION brain_check_source_submission_owner();
--> statement-breakpoint
CREATE FUNCTION brain_guard_native_source_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.chunker_id <> 'native_submission' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Submitted source captures are immutable; capture a new version or delete the owning project' USING ERRCODE='23514', CONSTRAINT='brain_native_capture_immutable';
END $$;
CREATE TRIGGER brain_native_source_capture_immutable BEFORE UPDATE OR DELETE ON brain_sources FOR EACH ROW EXECUTE FUNCTION brain_guard_native_source_capture();
