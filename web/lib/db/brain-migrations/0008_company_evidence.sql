-- Company Brain evidence (ADR-200): captured witnesses never follow reanchors.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE brain_evidence_observations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  source_id text NOT NULL,
  source_version text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  independence_group_id text,
  attribution jsonb NOT NULL CHECK (jsonb_typeof(attribution)='object'),
  observed_at timestamptz,
  source_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL) <> (company_id IS NULL)),
  CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 256)
);
CREATE UNIQUE INDEX brain_observations_project_version_uq ON brain_evidence_observations(project_id,source_id,coalesce(source_version,''),content_sha256) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX brain_observations_company_version_uq ON brain_evidence_observations(company_id,source_id,coalesce(source_version,''),content_sha256) WHERE company_id IS NOT NULL;
CREATE TABLE brain_evidence_witnesses (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  observation_id text NOT NULL REFERENCES brain_evidence_observations(id) ON DELETE CASCADE,
  source_version text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  selector text NOT NULL CHECK (length(selector)<=512),
  restrictions jsonb NOT NULL CHECK (jsonb_typeof(restrictions)='array'),
  capture_locator jsonb NOT NULL CHECK (jsonb_typeof(capture_locator)='object' AND pg_column_size(capture_locator)<=262144),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brain_witness_observation_selector_uq ON brain_evidence_witnesses(observation_id,coalesce(source_version,''),content_sha256,selector);
CREATE TABLE brain_revision_evidence (
  record_id text NOT NULL,
  revision integer NOT NULL,
  witness_id text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports','contradicts','derived_from','refines','references')),
  witness_snapshot jsonb NOT NULL CHECK (jsonb_typeof(witness_snapshot)='object' AND pg_column_size(witness_snapshot)<=16384),
  PRIMARY KEY(record_id,revision,witness_id,relation),
  FOREIGN KEY(record_id,revision) REFERENCES brain_record_revisions(record_id,revision) ON DELETE CASCADE
);
-- Cross-owner witness identity is validated by the service. Its removal cannot
-- block project deletion; the retained snapshot then resolves unavailable.
CREATE INDEX brain_revision_evidence_witness_idx ON brain_revision_evidence(witness_id,record_id,revision);
CREATE TRIGGER brain_revision_evidence_immutable BEFORE UPDATE OR DELETE ON brain_revision_evidence FOR EACH ROW EXECUTE FUNCTION brain_reject_history_mutation();
ALTER TABLE brain_edges ADD COLUMN claim_state text CHECK (claim_state IN ('potential_conflict','declared_conflict'));
ALTER TABLE brain_edges ADD COLUMN from_revision integer CHECK (from_revision>0);
ALTER TABLE brain_edges ADD COLUMN to_revision integer CHECK (to_revision>0);
ALTER TABLE brain_edges ADD COLUMN claim_actor jsonb;
ALTER TABLE brain_edges ADD CONSTRAINT brain_edges_claim_shape_check CHECK (claim_state IS NULL OR (from_ref->>'type'='item' AND to_ref->>'type'='item' AND from_revision IS NOT NULL AND to_revision IS NOT NULL AND jsonb_typeof(claim_actor)='object') IS TRUE);
CREATE INDEX brain_edges_claim_from_idx ON brain_edges((from_ref->>'id'),from_revision) WHERE claim_state IS NOT NULL;
CREATE INDEX brain_edges_claim_to_idx ON brain_edges((to_ref->>'id'),to_revision) WHERE claim_state IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION brain_guard_evidence_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_project text; source_company text;
BEGIN
  IF TG_TABLE_NAME='brain_evidence_observations' THEN
    source_project := OLD.project_id;
    source_company := OLD.company_id;
  ELSE
    SELECT project_id,company_id INTO source_project,source_company FROM brain_evidence_observations WHERE id=OLD.observation_id;
    IF TG_OP='DELETE' AND NOT FOUND THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP='DELETE' AND source_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=source_project) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Evidence captures are immutable' USING ERRCODE='23514', CONSTRAINT='brain_evidence_history_immutable';
END $$;
CREATE TRIGGER brain_observation_immutable BEFORE UPDATE OR DELETE ON brain_evidence_observations FOR EACH ROW EXECUTE FUNCTION brain_guard_evidence_history();
CREATE TRIGGER brain_witness_immutable BEFORE UPDATE OR DELETE ON brain_evidence_witnesses FOR EACH ROW EXECUTE FUNCTION brain_guard_evidence_history();
