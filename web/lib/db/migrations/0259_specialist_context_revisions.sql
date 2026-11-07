CREATE TABLE "specialist_context_revisions" (
	"assignment_id" text NOT NULL,
	"revision" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"input_revision" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"context" jsonb NOT NULL,
	"source_restrictions" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"owner_epoch" bigint,
	"principal_key" text NOT NULL,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_context_revisions_assignment_id_revision_pk" PRIMARY KEY("assignment_id","revision"),
	CONSTRAINT "specialist_context_request_uq" UNIQUE("assignment_id","principal_key","request_key"),
	CONSTRAINT "specialist_context_revision_check" CHECK (("specialist_context_revisions"."schema_version"=1 AND "specialist_context_revisions"."revision">0 AND "specialist_context_revisions"."base_revision">=0 AND "specialist_context_revisions"."revision"="specialist_context_revisions"."base_revision"+1 AND "specialist_context_revisions"."input_revision">0 AND ("specialist_context_revisions"."owner_epoch" IS NULL OR "specialist_context_revisions"."owner_epoch" BETWEEN 1 AND 9007199254740991)) IS TRUE),
	CONSTRAINT "specialist_context_identity_check" CHECK (("specialist_context_revisions"."principal_key" ~ '^[a-f0-9]{64}$' AND "specialist_context_revisions"."request_digest" ~ '^[a-f0-9]{64}$' AND "specialist_context_revisions"."content_digest" ~ '^[a-f0-9]{64}$' AND char_length("specialist_context_revisions"."request_key") BETWEEN 8 AND 128 AND "specialist_context_revisions"."request_key" ~ '^[A-Za-z0-9._:-]+$') IS TRUE),
	CONSTRAINT "specialist_context_actor_check" CHECK (((CASE WHEN jsonb_typeof("specialist_context_revisions"."actor")='object' THEN
    "specialist_context_revisions"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_context_revisions"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_context_revisions"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_context_revisions"."actor"->'id')='string'
    AND char_length("specialist_context_revisions"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_context_revisions"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_context_revisions"."actor"->'runId')='string' AND char_length("specialist_context_revisions"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_context_revisions"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_context_revisions"."actor"->'attemptId')='string' AND char_length("specialist_context_revisions"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND ("specialist_context_revisions"."actor"->>'kind'<>'user' OR "specialist_context_revisions"."owner_epoch" IS NULL)) IS TRUE),
	CONSTRAINT "specialist_context_snapshot_check" CHECK ((jsonb_typeof("specialist_context_revisions"."context")='object'
    AND "specialist_context_revisions"."context" ?& ARRAY['schemaVersion','inputRevision','inputSha256','entries']
    AND "specialist_context_revisions"."context"-ARRAY['schemaVersion','inputRevision','inputSha256','entries']='{}'::jsonb
    AND "specialist_context_revisions"."context"->'schemaVersion'='1'::jsonb AND "specialist_context_revisions"."context"->'inputRevision'=to_jsonb("specialist_context_revisions"."input_revision")
    AND jsonb_typeof("specialist_context_revisions"."context"->'inputSha256')='string' AND "specialist_context_revisions"."context"->>'inputSha256' ~ '^[a-f0-9]{64}$'
    AND CASE WHEN jsonb_typeof("specialist_context_revisions"."context"->'entries')='array' THEN jsonb_array_length("specialist_context_revisions"."context"->'entries')<=256 ELSE false END
    AND octet_length("specialist_context_revisions"."context"::text)<=131072 AND jsonb_typeof("specialist_context_revisions"."source_restrictions")='array'
    AND octet_length("specialist_context_revisions"."source_restrictions"::text)<=131072) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "specialist_context_revisions" ADD CONSTRAINT "specialist_context_revisions_assignment_id_specialist_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_context_revisions" ADD CONSTRAINT "specialist_context_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION guard_specialist_context_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent specialist_assignments%ROWTYPE;
DECLARE original specialist_input_revisions%ROWTYPE;
DECLARE previous_context specialist_context_revisions%ROWTYPE;
DECLARE item jsonb;
DECLARE previous_item jsonb;
BEGIN
  SELECT * INTO parent FROM specialist_assignments WHERE id=NEW.assignment_id FOR UPDATE;
  IF NOT FOUND OR NEW.base_revision<>parent.context_revision OR NEW.input_revision<>parent.input_revision
    OR parent.status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'Context must append to the exact current nonterminal assignment input and context'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_current_reference';
  END IF;
  SELECT * INTO original FROM specialist_input_revisions
    WHERE assignment_id=NEW.assignment_id AND revision=NEW.input_revision FOR SHARE;
  IF NOT FOUND OR NEW.context->>'inputSha256' IS DISTINCT FROM original.digest
    OR NOT (NEW.source_restrictions @> original.source_restrictions)
    OR NOT (NEW.source_restrictions @> jsonb_build_array(jsonb_build_object(
      'kind','assignment_input','assignmentId',NEW.assignment_id,'inputRevision',NEW.input_revision,'inputSha256',original.digest))) THEN
    RAISE EXCEPTION 'Context must retain its exact immutable input witness and source restrictions'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_input_reference';
  END IF;
  IF NEW.base_revision>0 THEN
    SELECT * INTO previous_context FROM specialist_context_revisions WHERE assignment_id=NEW.assignment_id AND revision=NEW.base_revision FOR SHARE;
    IF NOT FOUND OR NOT (NEW.source_restrictions @> previous_context.source_restrictions) THEN
      RAISE EXCEPTION 'Context cannot erase its previously classified source restrictions'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_source_retention';
    END IF;
  END IF;
  IF (SELECT count(DISTINCT value->'entry'->>'id') FROM jsonb_array_elements(NEW.context->'entries'))
    <>jsonb_array_length(NEW.context->'entries') THEN
    RAISE EXCEPTION 'Current context entry identities must be distinct'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_identity';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.context->'entries') LOOP
    IF item->'introducedRevision'=to_jsonb(NEW.revision) THEN
      IF item->'actor' IS DISTINCT FROM NEW.actor
        OR item->'ownerEpoch' IS DISTINCT FROM COALESCE(to_jsonb(NEW.owner_epoch),'null'::jsonb) THEN
        RAISE EXCEPTION 'New context entries must retain the server-recorded revision author and ownership witness'
          USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_attribution';
      END IF;
      IF item->'entry'->>'kind'='accepted' OR item->'entry'->>'state'='accepted' THEN
        RAISE EXCEPTION 'Accepted work requires its governed exact-result decision'
          USING ERRCODE='23514',CONSTRAINT='specialist_context_acceptance_unavailable';
      END IF;
      IF item->'entry' ? 'supersedesEntryId' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(previous_context.context->'entries','[]'::jsonb)) old_item
        WHERE old_item->'entry'->>'id'=item->'entry'->>'supersedesEntryId'
      ) THEN
        RAISE EXCEPTION 'A replacement must identify an entry in the exact base context'
          USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_replacement';
      END IF;
    ELSIF NOT (COALESCE(previous_context.context->'entries','[]'::jsonb) @> jsonb_build_array(item)) THEN
      RAISE EXCEPTION 'Retained context entries and their authors cannot be rewritten'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_attribution';
    END IF;
  END LOOP;
  FOR previous_item IN SELECT value FROM jsonb_array_elements(COALESCE(previous_context.context->'entries','[]'::jsonb)) LOOP
    IF NOT (NEW.context->'entries' @> jsonb_build_array(previous_item)) AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(NEW.context->'entries') replacement
      WHERE replacement->'introducedRevision'=to_jsonb(NEW.revision)
        AND replacement->'entry'->>'supersedesEntryId'=previous_item->'entry'->>'id'
    ) THEN
      RAISE EXCEPTION 'Removing context requires an explicit replacement; immutable history remains retained'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_replacement';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_context_insert_guard BEFORE INSERT ON specialist_context_revisions
FOR EACH ROW EXECUTE FUNCTION guard_specialist_context_insert();
--> statement-breakpoint
CREATE FUNCTION guard_specialist_context_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Retained working context revisions and request receipts are immutable'
    USING ERRCODE='23514',CONSTRAINT='specialist_context_history_immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_context_history_guard BEFORE UPDATE OR DELETE ON specialist_context_revisions
FOR EACH ROW EXECUTE FUNCTION guard_specialist_context_history();
--> statement-breakpoint
CREATE FUNCTION assert_specialist_context_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment_key text;
DECLARE current_revision integer;
DECLARE latest_revision integer;
BEGIN
  IF TG_TABLE_NAME='specialist_assignments' THEN assignment_key:=NEW.id;
  ELSE assignment_key:=NEW.assignment_id; END IF;
  SELECT context_revision INTO current_revision FROM specialist_assignments WHERE id=assignment_key;
  SELECT max(revision) INTO latest_revision FROM specialist_context_revisions WHERE assignment_id=assignment_key;
  IF current_revision IS NULL OR current_revision<>COALESCE(latest_revision,0) THEN
    RAISE EXCEPTION 'A context head must reference its exact latest immutable revision in the same transaction'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_head_reference';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_assignment_context_head AFTER INSERT OR UPDATE ON specialist_assignments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_specialist_context_head();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_context_revision_head AFTER INSERT ON specialist_context_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_specialist_context_head();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM specialist_assignments WHERE context_revision<>0) THEN
    RAISE EXCEPTION 'Existing nonzero context heads have no retained context history; inspect source integrity before migration'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_head_reference';
  END IF;
END $$;
