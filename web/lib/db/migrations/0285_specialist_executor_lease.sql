CREATE TABLE "specialist_owner_claims" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"placement_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "specialist_owner_claims_valid" CHECK ("specialist_owner_claims"."epoch">0 AND "specialist_owner_claims"."expires_at">"specialist_owner_claims"."renewed_at")
);
--> statement-breakpoint
ALTER TABLE "specialist_owner_claims" ADD CONSTRAINT "specialist_owner_claims_assignment_id_specialist_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_owner_claims" ADD CONSTRAINT "specialist_owner_claims_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_owner_claims" ADD CONSTRAINT "specialist_owner_claims_placement_id_execution_assignments_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION appoint_specialist_executor(candidate_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  subject_id text;
  current_input integer;
  owner_placement text;
  observed_at timestamptz := clock_timestamp();
BEGIN
  SELECT link.assignment_id, subject.input_revision, placement.id
    INTO subject_id,current_input,owner_placement
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN execution_assignments placement ON placement.id=source.execution_assignment_id
      AND placement.run_id=source.id AND placement.state='active'
    WHERE source.id=candidate_id AND source.parent_run_id IS NULL
      AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation')
      AND source.status IN ('Pending','Running','NeedsInput')
      AND (placement.lease_expires_at IS NULL OR placement.lease_expires_at>observed_at)
    FOR NO KEY UPDATE OF subject NOWAIT;
  IF NOT FOUND OR specialist_current_root_id(subject_id,current_input) IS DISTINCT FROM candidate_id THEN
    RETURN;
  END IF;
  INSERT INTO specialist_owner_claims(assignment_id,run_id,placement_id,epoch,renewed_at,expires_at)
    VALUES(subject_id,candidate_id,owner_placement,1,observed_at,observed_at+interval '120 seconds')
    ON CONFLICT(assignment_id) DO UPDATE
    SET run_id=excluded.run_id,placement_id=excluded.placement_id,
      epoch=specialist_owner_claims.epoch+1,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at
    WHERE specialist_owner_claims.placement_id<>excluded.placement_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION appoint_specialist_executor_on_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM appoint_specialist_executor(NEW.id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_executor_on_run AFTER UPDATE OF execution_assignment_id,status ON runs
  FOR EACH ROW WHEN (NEW.execution_assignment_id IS NOT NULL AND NEW.status IN ('Pending','Running','NeedsInput')
    AND (NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id
      OR OLD.status NOT IN ('Pending','Running','NeedsInput')))
  EXECUTE FUNCTION appoint_specialist_executor_on_run();
--> statement-breakpoint
CREATE FUNCTION appoint_specialist_executor_on_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM appoint_specialist_executor(NEW.run_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_executor_on_link AFTER INSERT ON specialist_run_links
  FOR EACH ROW WHEN (NEW.root_appointment_epoch IS NOT NULL)
  EXECUTE FUNCTION appoint_specialist_executor_on_link();
--> statement-breakpoint
-- Upgrade only exact, physically appointed roots. Historical context bytes stay unchanged.
SELECT appoint_specialist_executor(link.run_id)
  FROM specialist_run_links link JOIN runs source ON source.id=link.run_id
  WHERE source.parent_run_id IS NULL AND source.execution_assignment_id IS NOT NULL
    AND source.status IN ('Pending','Running','NeedsInput')
    AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation');
--> statement-breakpoint
CREATE FUNCTION specialist_execution_owner_epoch(candidate_id text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  subject_id text;
  current_input integer;
  root_id text;
  root_placement text;
  root_status text;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT subject.id,subject.input_revision,root.id,root.execution_assignment_id,root.status
    INTO subject_id,current_input,root_id,root_placement,root_status
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    LEFT JOIN runs root ON root.id=CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    WHERE source.id=candidate_id AND (
      (source.parent_run_id IS NULL AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
      OR (source.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL)
    );
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF root_id IS NULL OR specialist_current_root_id(subject_id,current_input) IS DISTINCT FROM root_id THEN
    RETURN -1;
  END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=subject_id FOR SHARE;
  IF NOT FOUND AND root_placement IS NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments WHERE run_id=root_id
  ) THEN
    RETURN NULL;
  END IF;
  IF claim.run_id IS DISTINCT FROM root_id OR claim.placement_id IS DISTINCT FROM root_placement
    OR claim.expires_at<=clock_timestamp() OR NOT EXISTS (
      SELECT 1 FROM execution_assignments placement WHERE placement.id=root_placement
        AND ((placement.state='active' AND (placement.lease_expires_at IS NULL OR placement.lease_expires_at>clock_timestamp()))
          OR (candidate_id<>root_id AND root_status='WaitingOnChildren'
            AND placement.state='released' AND placement.released_reason='waiting_on_children'))
    ) THEN
    RETURN -1;
  END IF;
  RETURN claim.epoch;
END $$;
--> statement-breakpoint
CREATE FUNCTION specialist_executor_branch(candidate_id text, candidate_placement text)
RETURNS TABLE(subject_id text, root_id text, root_placement_id text, root_parked boolean)
LANGUAGE sql STABLE AS $$
  SELECT link.assignment_id, root.id, owner_placement.id, root.status='WaitingOnChildren'
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN runs root ON root.id=CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    JOIN execution_assignments actor_placement ON actor_placement.id=source.execution_assignment_id
      AND actor_placement.run_id=source.id AND actor_placement.state='active'
    JOIN execution_assignments owner_placement ON owner_placement.id=root.execution_assignment_id
      AND owner_placement.run_id=root.id
    WHERE source.id=candidate_id AND actor_placement.id=candidate_placement
      AND source.status IN ('Running','NeedsInput')
      AND (actor_placement.lease_expires_at IS NULL OR actor_placement.lease_expires_at>clock_timestamp())
      AND subject.status IN ('active','waiting_input','waiting_children','reconciling')
      AND specialist_current_root_id(subject.id,subject.input_revision)=root.id
      AND ((source.id=root.id AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
        OR (source.id<>root.id AND link.work_witness IS NOT NULL))
      AND ((owner_placement.state='active'
        AND (owner_placement.lease_expires_at IS NULL OR owner_placement.lease_expires_at>clock_timestamp()))
        OR (source.id<>root.id AND root.status='WaitingOnChildren'
          AND owner_placement.state='released' AND owner_placement.released_reason='waiting_on_children'))
$$;
--> statement-breakpoint
CREATE FUNCTION begin_specialist_executor(candidate_id text, candidate_placement text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  assignment_identity text;
  linked_root text;
  branch record;
  observed_at timestamptz;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT link.assignment_id, CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    INTO assignment_identity,linked_root FROM runs source
    JOIN specialist_run_links link ON link.run_id=source.id
    WHERE source.id=candidate_id AND (
      (source.parent_run_id IS NULL AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
      OR (source.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL)
    )
    FOR NO KEY UPDATE OF source;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF linked_root<>candidate_id AND NOT EXISTS (
    SELECT 1 FROM execution_assignments WHERE run_id=linked_root
  ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=assignment_identity FOR UPDATE;
  IF NOT FOUND THEN RETURN -1; END IF;
  SELECT * INTO branch FROM specialist_executor_branch(candidate_id,candidate_placement);
  IF NOT FOUND OR claim.run_id<>branch.root_id OR claim.placement_id<>branch.root_placement_id THEN
    RETURN -1;
  END IF;
  observed_at := clock_timestamp();
  IF claim.expires_at>observed_at THEN RETURN claim.epoch; END IF;
  IF candidate_id<>branch.root_id AND NOT branch.root_parked THEN RETURN -1; END IF;
  UPDATE specialist_owner_claims SET epoch=claim.epoch+1,renewed_at=observed_at,expires_at=observed_at+interval '120 seconds'
    WHERE assignment_id=assignment_identity AND epoch=claim.epoch RETURNING epoch INTO claim.epoch;
  RETURN claim.epoch;
END $$;
--> statement-breakpoint
CREATE FUNCTION renew_specialist_executor(candidate_id text, candidate_placement text, expected_epoch integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  observed_at timestamptz := clock_timestamp();
  branch record;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT * INTO branch FROM specialist_executor_branch(candidate_id,candidate_placement);
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=branch.subject_id;
  IF NOT FOUND OR claim.epoch<>expected_epoch OR claim.run_id<>branch.root_id
    OR claim.placement_id<>branch.root_placement_id OR claim.expires_at<=observed_at THEN
    RETURN false;
  END IF;
  IF (candidate_id<>branch.root_id AND NOT branch.root_parked)
    OR claim.renewed_at>observed_at-interval '40 seconds' THEN RETURN true; END IF;
  UPDATE specialist_owner_claims SET renewed_at=observed_at,expires_at=observed_at+interval '120 seconds'
    WHERE assignment_id=claim.assignment_id AND run_id=branch.root_id AND placement_id=branch.root_placement_id
      AND epoch=claim.epoch AND expires_at>clock_timestamp()
      AND renewed_at<=observed_at-interval '40 seconds';
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM specialist_owner_claims
    WHERE assignment_id=claim.assignment_id AND epoch=expected_epoch AND expires_at>clock_timestamp());
END $$;
--> statement-breakpoint
CREATE FUNCTION assert_specialist_executor(candidate_id text, candidate_placement text, expected_epoch integer)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_owner_claims claim ON claim.assignment_id=link.assignment_id
    JOIN runs root ON root.id=claim.run_id AND root.execution_assignment_id=claim.placement_id
    WHERE source.id=candidate_id AND source.execution_assignment_id=candidate_placement
      AND (source.id=root.id OR source.root_run_id=root.id)
      AND claim.epoch=expected_epoch AND claim.expires_at>clock_timestamp()
    FOR SHARE OF claim
  )
$$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_context_owner_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_epoch integer;
BEGIN
  IF NEW.actor->>'kind'='agent' THEN
    current_epoch := specialist_execution_owner_epoch(NEW.actor->>'runId');
  END IF;
  IF current_epoch=-1 OR NEW.owner_epoch IS DISTINCT FROM current_epoch OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.context->'entries') item
      WHERE item->'introducedRevision'=to_jsonb(NEW.revision)
        AND item->'ownerEpoch' IS DISTINCT FROM COALESCE(to_jsonb(NEW.owner_epoch),'null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'Context requires the current specialist executor lease'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_owner_epoch_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_context_01_owner_epoch_guard BEFORE INSERT ON specialist_context_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_specialist_context_owner_epoch();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_work_owner_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF specialist_execution_owner_epoch(NEW.parent_run_id)=-1 THEN
    RAISE EXCEPTION 'Delegation requires the current specialist executor lease'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_owner_epoch_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_work_01_owner_epoch_guard BEFORE INSERT ON specialist_work
  FOR EACH ROW EXECUTE FUNCTION guard_specialist_work_owner_epoch();
