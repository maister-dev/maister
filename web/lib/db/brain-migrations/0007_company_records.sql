-- Company Brain (ADR-200): explicit owners and immutable assertion revisions.
-- Hand-authored Brain lineage; all main migrations must be applied first.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE brain_items ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_items ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_items ADD CONSTRAINT brain_items_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_items_company_idx ON brain_items(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_sources ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_sources ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_sources ADD CONSTRAINT brain_sources_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_sources_company_idx ON brain_sources(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_chunks ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_chunks ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_chunks ADD CONSTRAINT brain_chunks_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_chunks_company_idx ON brain_chunks(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_snapshots ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_snapshots ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_snapshots ADD CONSTRAINT brain_snapshots_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_snapshots_company_idx ON brain_snapshots(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_edges ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_edges ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_edges ADD CONSTRAINT brain_edges_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_edges_company_idx ON brain_edges(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_proposals ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE brain_proposals ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE brain_proposals ADD CONSTRAINT brain_proposals_owner_check CHECK ((project_id IS NULL) <> (company_id IS NULL));
CREATE INDEX brain_proposals_company_idx ON brain_proposals(company_id,id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE brain_items ADD COLUMN current_revision integer NOT NULL DEFAULT 1;
ALTER TABLE brain_items ADD COLUMN visibility text NOT NULL DEFAULT 'owner_grants';
ALTER TABLE brain_items ADD CONSTRAINT brain_items_visibility_check CHECK (visibility IN ('owner_grants','restricted'));
ALTER TABLE brain_items ADD CONSTRAINT brain_items_revision_check CHECK (current_revision > 0);
ALTER TABLE brain_items DROP CONSTRAINT brain_items_kind_check;
ALTER TABLE brain_items ADD CONSTRAINT brain_items_kind_check CHECK (kind IN ('assertion','observation','decision','procedure','lesson','state_fact','direction'));
ALTER TABLE brain_items DROP CONSTRAINT brain_items_status_check;
ALTER TABLE brain_items ADD CONSTRAINT brain_items_status_check CHECK (status IN ('active','expired','superseded','withdrawn'));
CREATE UNIQUE INDEX brain_items_company_active_hash_uq ON brain_items(company_id,content_hash) WHERE company_id IS NOT NULL AND status='active';
CREATE UNIQUE INDEX brain_items_company_event_uq ON brain_items(company_id,source_domain_event_id) WHERE company_id IS NOT NULL AND source_domain_event_id IS NOT NULL;
ALTER TABLE brain_sources ADD COLUMN title text;
ALTER TABLE brain_sources ADD COLUMN submitted_content text;
ALTER TABLE brain_sources ADD CONSTRAINT brain_sources_company_text_check CHECK (company_id IS NULL OR (kind='text' AND NOT profile_managed AND title IS NOT NULL AND length(title) BETWEEN 1 AND 256 AND submitted_content IS NOT NULL AND length(submitted_content) BETWEEN 1 AND 32000 AND octet_length(submitted_content) <= 262144));
CREATE UNIQUE INDEX brain_sources_company_path_uq ON brain_sources(company_id,path) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX brain_chunks_company_stable_uq ON brain_chunks(source_id,stable_id) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX brain_proposals_company_cluster_uq ON brain_proposals(company_id,cluster_hash) WHERE company_id IS NOT NULL AND cluster_hash IS NOT NULL;
--> statement-breakpoint
CREATE TABLE brain_record_revisions (
  record_id text NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  assertion text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assertion','observation','decision','procedure','lesson','state_fact','direction')),
  basis text NOT NULL CHECK (basis IN ('observed','inferred','unknown')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  attribution jsonb NOT NULL CHECK (jsonb_typeof(attribution)='object'),
  freshness jsonb NOT NULL CHECK (jsonb_typeof(freshness)='object'),
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(limitations)='array'),
  proposal_id text REFERENCES brain_proposals(id) ON DELETE CASCADE,
  provenance text NOT NULL CHECK (provenance IN ('submitted','legacy_migration','legacy_writer')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_id,revision),
  CONSTRAINT brain_record_revisions_content_bounds CHECK (provenance <> 'submitted' OR (length(title) BETWEEN 1 AND 256 AND length(assertion) BETWEEN 1 AND 32000))
);
CREATE TABLE brain_record_grants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  record_id text NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user','agent','system')),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('knowledge:read','knowledge:propose','knowledge:review','knowledge:confirm','knowledge:manage')),
  created_by jsonb NOT NULL CHECK (jsonb_typeof(created_by)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX brain_record_grants_live_uq ON brain_record_grants(record_id,principal_type,principal_id,action) WHERE revoked_at IS NULL;
CREATE TABLE brain_record_changes (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  record_id text NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  prior_revision integer,
  accepted_revision integer NOT NULL,
  proposal_id text REFERENCES brain_proposals(id) ON DELETE CASCADE,
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor)='object'),
  originating_work jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(record_id,accepted_revision),
  FOREIGN KEY(record_id,prior_revision) REFERENCES brain_record_revisions(record_id,revision) ON DELETE CASCADE,
  FOREIGN KEY(record_id,accepted_revision) REFERENCES brain_record_revisions(record_id,revision) ON DELETE CASCADE
);
-- This is a current-state capture, never a fabricated historical publication.
INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance)
SELECT id,1,content,title,kind,'unknown',encode(sha256(convert_to(content,'UTF8')),'hex'),
  jsonb_build_object('kind','legacy_unknown','id',NULL,'runId',source_run_id,'attemptId',source_node_attempt_id),
  jsonb_build_object('state','unknown','applicability','unknown','observedAt',NULL,'sourceAt',NULL,'capturedAt',now()),
  '["Legacy metadata does not establish submitting identity, observation time or confirmation."]'::jsonb,'legacy_migration'
FROM brain_items;
ALTER TABLE brain_items ADD CONSTRAINT brain_items_current_revision_fk FOREIGN KEY(id,current_revision) REFERENCES brain_record_revisions(record_id,revision) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION brain_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM brain_items i WHERE i.id=OLD.record_id
      AND (i.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=i.project_id))
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Knowledge history is immutable; create a new attributed revision' USING ERRCODE='23514', CONSTRAINT='brain_record_revision_immutable';
END $$;
CREATE TRIGGER brain_record_revisions_immutable BEFORE UPDATE OR DELETE ON brain_record_revisions FOR EACH ROW EXECUTE FUNCTION brain_reject_history_mutation();
CREATE TRIGGER brain_record_changes_immutable BEFORE UPDATE OR DELETE ON brain_record_changes FOR EACH ROW EXECUTE FUNCTION brain_reject_history_mutation();
CREATE FUNCTION brain_preserve_record_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Knowledge ownership is immutable' USING ERRCODE='23514', CONSTRAINT='brain_record_owner_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_items_owner_immutable BEFORE UPDATE ON brain_items FOR EACH ROW EXECUTE FUNCTION brain_preserve_record_owner();
CREATE TRIGGER brain_sources_owner_immutable BEFORE UPDATE ON brain_sources FOR EACH ROW EXECUTE FUNCTION brain_preserve_record_owner();
CREATE FUNCTION brain_legacy_revision_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_provenance text;
BEGIN
  -- Only trusted native services set this transaction-local writer declaration.
  IF current_setting('maister.knowledge_writer',true) = 'native_v1' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_revision <> OLD.current_revision THEN
      RAISE EXCEPTION 'Native revision authority is required' USING ERRCODE='23514', CONSTRAINT='brain_record_native_writer_required';
    END IF;
    IF NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.content IS NOT DISTINCT FROM OLD.content AND NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
    SELECT provenance INTO old_provenance FROM brain_record_revisions WHERE record_id=OLD.id AND revision=OLD.current_revision;
    IF old_provenance='submitted' THEN
      RAISE EXCEPTION 'Structured assertions require an attributed correction' USING ERRCODE='23514', CONSTRAINT='brain_record_native_writer_required';
    END IF;
    NEW.current_revision := OLD.current_revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_items_legacy_head BEFORE INSERT OR UPDATE ON brain_items FOR EACH ROW EXECUTE FUNCTION brain_legacy_revision_write();
CREATE FUNCTION brain_capture_legacy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('maister.knowledge_writer',true) = 'native_v1' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.current_revision=OLD.current_revision THEN RETURN NULL; END IF;
  INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance)
  VALUES (NEW.id,NEW.current_revision,NEW.content,NEW.title,NEW.kind,'unknown',encode(sha256(convert_to(NEW.content,'UTF8')),'hex'),
    jsonb_build_object('kind','legacy_unknown','id',NULL,'runId',NEW.source_run_id,'attemptId',NEW.source_node_attempt_id),
    jsonb_build_object('state','unknown','applicability','unknown','observedAt',NULL,'sourceAt',NULL,'capturedAt',now()),
    '["Legacy writer metadata does not establish submitting identity, observation time or confirmation."]'::jsonb,'legacy_writer');
  RETURN NULL;
END $$;
CREATE TRIGGER brain_items_legacy_revision AFTER INSERT OR UPDATE ON brain_items FOR EACH ROW EXECUTE FUNCTION brain_capture_legacy_revision();
--> statement-breakpoint
CREATE FUNCTION brain_check_source_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_project text; source_company text;
BEGIN
  IF NEW.source_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id,company_id INTO source_project,source_company FROM brain_sources WHERE id=NEW.source_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- The existing source FK reports missing sources.
  IF TG_TABLE_NAME='brain_index_jobs' THEN
    IF source_project IS DISTINCT FROM NEW.project_id OR source_company IS NOT NULL THEN
      RAISE EXCEPTION 'Repository indexing requires a matching project source' USING ERRCODE='23514', CONSTRAINT='brain_source_owner_check';
    END IF;
  ELSIF source_project IS DISTINCT FROM NEW.project_id OR source_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Chunk and source ownership must match' USING ERRCODE='23514', CONSTRAINT='brain_source_owner_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_chunks_owner_check BEFORE INSERT OR UPDATE ON brain_chunks FOR EACH ROW EXECUTE FUNCTION brain_check_source_owner();
CREATE TRIGGER brain_index_jobs_owner_check BEFORE INSERT OR UPDATE ON brain_index_jobs FOR EACH ROW EXECUTE FUNCTION brain_check_source_owner();
--> statement-breakpoint
CREATE FUNCTION brain_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consistent boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM brain_items WHERE id=NEW.id) THEN RETURN NULL; END IF;
  SELECT (i.title=r.title AND i.content=r.assertion AND i.kind=r.kind) INTO consistent
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
CREATE CONSTRAINT TRIGGER brain_items_revision_consistent AFTER INSERT OR UPDATE ON brain_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION brain_check_current_revision();
--> statement-breakpoint
CREATE FUNCTION brain_restrict_record_on_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE brain_items SET visibility='restricted' WHERE id=NEW.record_id AND visibility <> 'restricted';
  RETURN NEW;
END $$;
CREATE TRIGGER brain_record_grants_restrict BEFORE INSERT OR UPDATE ON brain_record_grants FOR EACH ROW EXECUTE FUNCTION brain_restrict_record_on_grant();
--> statement-breakpoint
CREATE FUNCTION brain_guard_record_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Withdraw a knowledge record or delete its owning project; direct history removal is forbidden' USING ERRCODE='23514', CONSTRAINT='brain_record_delete_requires_project_cascade';
END $$;
CREATE TRIGGER brain_items_delete_guard BEFORE DELETE ON brain_items FOR EACH ROW EXECUTE FUNCTION brain_guard_record_deletion();
