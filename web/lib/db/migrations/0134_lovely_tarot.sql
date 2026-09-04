-- ADR-167 T4.3: `scratch_runs.supervisor_session_id` was an unconstrained
-- mirror. It can be removed only after every non-null value is proven against
-- one authoritative assignment/host/session association. Drizzle can express
-- the DROP but not the preservation-or-fail preflight, so keep this deliberate
-- guard with the generated journal/snapshot.
DO $$
DECLARE
  unresolved_run_id text;
BEGIN
  -- A destructive compatibility removal is never allowed while an old active
  -- run could still require the legacy path. Terminal historical rows remain
  -- readable through the canonical tables created below.
  SELECT id INTO unresolved_run_id
  FROM runs
  WHERE execution_data_plane_mode = 'legacy_file_v1'
    AND status NOT IN ('Done', 'Failed', 'Crashed', 'Abandoned')
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot drop scratch supervisor session mirror: active legacy run % remains',
      unresolved_run_id;
  END IF;

  -- One run may have many historical assignments. A mirror is only provable
  -- when exactly one assignment describes its host. Do not guess a host from
  -- an arbitrary newest assignment.
  SELECT sr.run_id INTO unresolved_run_id
  FROM scratch_runs sr
  WHERE sr.supervisor_session_id IS NOT NULL
    AND (
      SELECT count(*)
      FROM execution_assignments ea
      WHERE ea.run_id = sr.run_id
    ) <> 1
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot preserve scratch supervisor session mirror for run %: assignment ownership is ambiguous or missing',
      unresolved_run_id;
  END IF;

  -- The default logical session is the scratch target. A different existing
  -- canonical host pointer is a data conflict, not a last-write-wins update.
  SELECT sr.run_id INTO unresolved_run_id
  FROM scratch_runs sr
  JOIN run_sessions rs
    ON rs.run_id = sr.run_id
   AND rs.session_name = 'default'
  WHERE sr.supervisor_session_id IS NOT NULL
    AND rs.host_session_id IS NOT NULL
    AND rs.host_session_id <> sr.supervisor_session_id
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot preserve scratch supervisor session mirror for run %: canonical default session conflicts',
      unresolved_run_id;
  END IF;

  -- A concrete host session may never be reassigned across runs.
  SELECT sr.run_id INTO unresolved_run_id
  FROM scratch_runs sr
  JOIN execution_assignments ea ON ea.run_id = sr.run_id
  JOIN run_session_incarnations rsi
    ON rsi.execution_host_id = ea.execution_host_id
   AND rsi.host_session_id = sr.supervisor_session_id
  WHERE sr.supervisor_session_id IS NOT NULL
    AND rsi.run_id <> sr.run_id
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot preserve scratch supervisor session mirror for run %: host session belongs to another run',
      unresolved_run_id;
  END IF;

  -- Insert a deterministic logical default row when the legacy mirror was the
  -- sole known session. Text IDs are deliberate: the schema has no UUID type
  -- restriction and deterministic values make a retried migration auditable.
  INSERT INTO run_sessions (
    id,
    run_id,
    session_name,
    execution_assignment_id,
    host_session_id,
    created_at,
    updated_at
  )
  SELECT
    'legacy-scratch-session:' || sr.run_id,
    sr.run_id,
    'default',
    ea.id,
    sr.supervisor_session_id,
    now(),
    now()
  FROM scratch_runs sr
  JOIN execution_assignments ea ON ea.run_id = sr.run_id
  LEFT JOIN run_sessions rs
    ON rs.run_id = sr.run_id
   AND rs.session_name = 'default'
  WHERE sr.supervisor_session_id IS NOT NULL
    AND rs.id IS NULL;

  UPDATE run_sessions rs
  SET
    execution_assignment_id = ea.id,
    host_session_id = sr.supervisor_session_id,
    updated_at = now()
  FROM scratch_runs sr
  JOIN execution_assignments ea ON ea.run_id = sr.run_id
  WHERE rs.run_id = sr.run_id
    AND rs.session_name = 'default'
    AND sr.supervisor_session_id IS NOT NULL
    AND rs.host_session_id IS NULL;

  -- Retain immutable audit history. Existing native rows are left untouched;
  -- only a missing exact host session gains a clearly-labelled backfill row.
  INSERT INTO run_session_incarnations (
    id,
    run_session_id,
    run_id,
    execution_assignment_id,
    assignment_epoch,
    execution_host_id,
    host_session_id,
    state,
    origin,
    created_at,
    activated_at,
    terminal_reason
  )
  SELECT
    'legacy-scratch-incarnation:' || sr.run_id,
    rs.id,
    sr.run_id,
    ea.id,
    ea.epoch,
    ea.execution_host_id,
    sr.supervisor_session_id,
    'exited',
    'legacy_backfill',
    now(),
    now(),
    jsonb_build_object('source', 'scratch_runs.supervisor_session_id')
  FROM scratch_runs sr
  JOIN execution_assignments ea ON ea.run_id = sr.run_id
  JOIN run_sessions rs
    ON rs.run_id = sr.run_id
   AND rs.session_name = 'default'
  LEFT JOIN run_session_incarnations rsi
    ON rsi.execution_host_id = ea.execution_host_id
   AND rsi.host_session_id = sr.supervisor_session_id
  WHERE sr.supervisor_session_id IS NOT NULL
    AND rsi.id IS NULL;

  SELECT sr.run_id INTO unresolved_run_id
  FROM scratch_runs sr
  JOIN execution_assignments ea ON ea.run_id = sr.run_id
  LEFT JOIN run_sessions rs
    ON rs.run_id = sr.run_id
   AND rs.session_name = 'default'
  LEFT JOIN run_session_incarnations rsi
    ON rsi.execution_host_id = ea.execution_host_id
   AND rsi.host_session_id = sr.supervisor_session_id
  WHERE sr.supervisor_session_id IS NOT NULL
    AND (
      rs.host_session_id IS DISTINCT FROM sr.supervisor_session_id
      OR rsi.run_id IS DISTINCT FROM sr.run_id
    )
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot drop scratch supervisor session mirror: preservation could not be proven for run %',
      unresolved_run_id;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "scratch_runs" DROP COLUMN IF EXISTS "supervisor_session_id";
