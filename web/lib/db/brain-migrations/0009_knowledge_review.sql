-- Native knowledge proposals share the existing Brain proposal store.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
-- Deduplication must never disclose a narrower record through a unique conflict.
DROP INDEX brain_items_active_hash_uq;
DROP INDEX brain_items_company_active_hash_uq;
CREATE UNIQUE INDEX brain_items_active_hash_uq ON brain_items(project_id,content_hash) WHERE status='active' AND visibility='owner_grants';
CREATE UNIQUE INDEX brain_items_company_active_hash_uq ON brain_items(company_id,content_hash) WHERE company_id IS NOT NULL AND status='active' AND visibility='owner_grants';
ALTER TABLE brain_record_revisions ADD COLUMN missing_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_evidence)='array');
ALTER TABLE brain_proposals DROP CONSTRAINT brain_proposals_kind_check;
ALTER TABLE brain_proposals ADD CONSTRAINT brain_proposals_kind_check CHECK (kind IN ('rule','skill','flow','adr','roadmap','state','knowledge_add','knowledge_correct'));
ALTER TABLE brain_proposals ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision>0);
ALTER TABLE brain_proposals ADD COLUMN principal_key text;
ALTER TABLE brain_proposals ADD COLUMN submission_key text;
ALTER TABLE brain_proposals ADD COLUMN request_digest text;
ALTER TABLE brain_proposals ADD COLUMN knowledge_attribution jsonb;
ALTER TABLE brain_proposals ADD COLUMN target_record_id text REFERENCES brain_items(id) ON DELETE CASCADE;
ALTER TABLE brain_proposals ADD COLUMN expected_record_revision integer;
ALTER TABLE brain_proposals ADD COLUMN published_record_id text REFERENCES brain_items(id) ON DELETE CASCADE;
ALTER TABLE brain_proposals ADD COLUMN published_record_revision integer;
ALTER TABLE brain_proposals ADD COLUMN decision_key text;
ALTER TABLE brain_proposals ADD COLUMN decision_digest text;
ALTER TABLE brain_proposals ADD COLUMN authority_snapshot jsonb;
ALTER TABLE brain_proposals ADD CONSTRAINT brain_proposals_knowledge_shape_check CHECK (kind NOT IN ('knowledge_add','knowledge_correct') OR (
  submission_key IS NOT NULL AND length(submission_key) BETWEEN 8 AND 128 AND request_digest ~ '^[a-f0-9]{64}$'
  AND principal_key IS NOT NULL AND jsonb_typeof(knowledge_attribution)='object' AND autonomy_decision='manual'
  AND ((kind='knowledge_add' AND target_record_id IS NULL AND expected_record_revision IS NULL) OR (kind='knowledge_correct' AND target_record_id IS NOT NULL AND expected_record_revision>0))
  AND ((status='pending' AND decision_key IS NULL AND published_record_id IS NULL AND published_record_revision IS NULL)
    OR (status='accepted' AND decision_key IS NOT NULL AND decision_digest ~ '^[a-f0-9]{64}$' AND published_record_id IS NOT NULL AND published_record_revision>0)
    OR (status='rejected' AND decision_key IS NOT NULL AND decision_digest ~ '^[a-f0-9]{64}$' AND published_record_id IS NULL AND published_record_revision IS NULL))
) IS TRUE);
CREATE UNIQUE INDEX brain_proposals_project_delivery_uq ON brain_proposals(project_id,principal_key,submission_key) WHERE submission_key IS NOT NULL AND project_id IS NOT NULL;
CREATE UNIQUE INDEX brain_proposals_company_delivery_uq ON brain_proposals(company_id,principal_key,submission_key) WHERE submission_key IS NOT NULL AND company_id IS NOT NULL;
CREATE UNIQUE INDEX brain_proposals_project_input_uq ON brain_proposals(project_id,principal_key,request_digest) WHERE principal_key IS NOT NULL AND project_id IS NOT NULL;
CREATE UNIQUE INDEX brain_proposals_company_input_uq ON brain_proposals(company_id,principal_key,request_digest) WHERE principal_key IS NOT NULL AND company_id IS NOT NULL;
CREATE TABLE brain_knowledge_submissions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  proposal_id text NOT NULL REFERENCES brain_proposals(id) ON DELETE CASCADE,
  principal_key text NOT NULL,
  delivery_key text NOT NULL CHECK (length(delivery_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  attribution jsonb NOT NULL CHECK (jsonb_typeof(attribution)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((project_id IS NULL) <> (company_id IS NULL))
);
CREATE UNIQUE INDEX brain_submissions_project_delivery_uq ON brain_knowledge_submissions(project_id,principal_key,delivery_key) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX brain_submissions_company_delivery_uq ON brain_knowledge_submissions(company_id,principal_key,delivery_key) WHERE company_id IS NOT NULL;
CREATE FUNCTION brain_guard_submission_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Knowledge submission identity is immutable' USING ERRCODE='23514', CONSTRAINT='brain_submission_immutable';
END $$;
CREATE TRIGGER brain_submissions_immutable BEFORE UPDATE OR DELETE ON brain_knowledge_submissions FOR EACH ROW EXECUTE FUNCTION brain_guard_submission_history();
CREATE TABLE brain_confirmations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  decision_sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  record_id text NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  record_revision integer NOT NULL CHECK (record_revision>0),
  decision text NOT NULL CHECK (decision IN ('confirm','revoke')),
  confirmer jsonb NOT NULL CHECK (jsonb_typeof(confirmer)='object'),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot)='object'),
  evidence_witnesses jsonb NOT NULL CHECK (jsonb_typeof(evidence_witnesses)='array'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(record_id,idempotency_key),
  FOREIGN KEY(record_id,record_revision) REFERENCES brain_record_revisions(record_id,revision) ON DELETE CASCADE
);
CREATE INDEX brain_confirmations_revision_order_idx ON brain_confirmations(record_id,record_revision,decision_sequence DESC);
CREATE TRIGGER brain_confirmations_immutable BEFORE UPDATE OR DELETE ON brain_confirmations FOR EACH ROW EXECUTE FUNCTION brain_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION brain_guard_native_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind NOT IN ('knowledge_add','knowledge_correct') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Native knowledge proposals retain their attributed history' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  IF (NEW.project_id,NEW.company_id,NEW.kind,NEW.draft,NEW.actor,NEW.principal_key,NEW.submission_key,NEW.request_digest,NEW.knowledge_attribution,NEW.target_record_id,NEW.expected_record_revision)
    IS DISTINCT FROM (OLD.project_id,OLD.company_id,OLD.kind,OLD.draft,OLD.actor,OLD.principal_key,OLD.submission_key,OLD.request_digest,OLD.knowledge_attribution,OLD.target_record_id,OLD.expected_record_revision) THEN
    RAISE EXCEPTION 'Knowledge proposal input is immutable' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  IF OLD.status<>'pending' AND (NEW.status,NEW.revision,NEW.decision_key,NEW.decision_digest,NEW.published_record_id,NEW.published_record_revision,NEW.resolution) IS DISTINCT FROM (OLD.status,OLD.revision,OLD.decision_key,OLD.decision_digest,OLD.published_record_id,OLD.published_record_revision,OLD.resolution) THEN
    RAISE EXCEPTION 'Knowledge proposal decision is immutable' USING ERRCODE='23514', CONSTRAINT='brain_proposal_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_native_proposal_immutable BEFORE UPDATE OR DELETE ON brain_proposals FOR EACH ROW EXECUTE FUNCTION brain_guard_native_proposal();
--> statement-breakpoint
-- Local proposal/history FKs may cascade only within one lifetime owner.
CREATE FUNCTION brain_assert_proposal_record_owner(record_identity text, proposal_project text, proposal_company text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE record_project text; record_company text;
BEGIN
  SELECT project_id,company_id INTO record_project,record_company FROM brain_items WHERE id=record_identity;
  IF FOUND AND (record_project IS DISTINCT FROM proposal_project OR record_company IS DISTINCT FROM proposal_company) THEN
    RAISE EXCEPTION 'Proposal and accepted record must have the same lifetime owner' USING ERRCODE='23514', CONSTRAINT='brain_proposal_record_owner_check';
  END IF;
END $$;
CREATE FUNCTION brain_check_proposal_record_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reference_id text; proposal_project text; proposal_company text;
BEGIN
  IF TG_TABLE_NAME='brain_proposals' THEN
    FOREACH reference_id IN ARRAY ARRAY[NEW.target_record_id,NEW.published_record_id] LOOP
      IF reference_id IS NOT NULL THEN PERFORM brain_assert_proposal_record_owner(reference_id,NEW.project_id,NEW.company_id); END IF;
    END LOOP;
  ELSIF NEW.proposal_id IS NOT NULL THEN
    SELECT project_id,company_id INTO proposal_project,proposal_company FROM brain_proposals WHERE id=NEW.proposal_id;
    IF FOUND THEN PERFORM brain_assert_proposal_record_owner(NEW.record_id,proposal_project,proposal_company); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_proposals_record_owner BEFORE INSERT OR UPDATE ON brain_proposals FOR EACH ROW EXECUTE FUNCTION brain_check_proposal_record_owner();
CREATE TRIGGER brain_revisions_proposal_owner BEFORE INSERT ON brain_record_revisions FOR EACH ROW EXECUTE FUNCTION brain_check_proposal_record_owner();
CREATE TRIGGER brain_changes_proposal_owner BEFORE INSERT ON brain_record_changes FOR EACH ROW EXECUTE FUNCTION brain_check_proposal_record_owner();
--> statement-breakpoint
CREATE FUNCTION brain_check_submission_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal_project text; proposal_company text;
BEGIN
  SELECT project_id,company_id INTO proposal_project,proposal_company FROM brain_proposals WHERE id=NEW.proposal_id;
  IF FOUND AND (proposal_project IS DISTINCT FROM NEW.project_id OR proposal_company IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'Submission and proposal must have the same lifetime owner' USING ERRCODE='23514', CONSTRAINT='brain_submission_owner_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_submissions_owner BEFORE INSERT ON brain_knowledge_submissions FOR EACH ROW EXECUTE FUNCTION brain_check_submission_owner();
