CREATE TABLE "company_specialist_binding_revisions" (
	"binding_id" text NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"authority_snapshot" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"request_actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_specialist_binding_revisions_binding_id_revision_pk" PRIMARY KEY("binding_id","revision"),
	CONSTRAINT "company_specialist_binding_revisions_request_uq" UNIQUE("binding_id","request_actor_id","request_key"),
	CONSTRAINT "company_specialist_binding_revisions_version_check" CHECK ("company_specialist_binding_revisions"."revision">0 AND "company_specialist_binding_revisions"."operation" IN ('created','updated','detached')),
	CONSTRAINT "company_specialist_binding_revisions_actor_check" CHECK ((CASE WHEN jsonb_typeof("company_specialist_binding_revisions"."actor")='object' THEN
    "company_specialist_binding_revisions"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "company_specialist_binding_revisions"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "company_specialist_binding_revisions"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("company_specialist_binding_revisions"."actor"->'id')='string'
    AND char_length("company_specialist_binding_revisions"."actor"->>'id') BETWEEN 1 AND 192
    AND ("company_specialist_binding_revisions"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("company_specialist_binding_revisions"."actor"->'runId')='string' AND char_length("company_specialist_binding_revisions"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("company_specialist_binding_revisions"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("company_specialist_binding_revisions"."actor"->'attemptId')='string' AND char_length("company_specialist_binding_revisions"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND ("company_specialist_binding_revisions"."actor"->>'kind'='user' AND "company_specialist_binding_revisions"."actor"->>'id'="company_specialist_binding_revisions"."request_actor_id" AND "company_specialist_binding_revisions"."actor"->'runId'='null'::jsonb AND "company_specialist_binding_revisions"."actor"->'attemptId'='null'::jsonb AND char_length("company_specialist_binding_revisions"."request_actor_id") BETWEEN 1 AND 192) IS TRUE),
	CONSTRAINT "company_specialist_binding_revisions_receipt_check" CHECK ("company_specialist_binding_revisions"."request_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "company_specialist_binding_revisions"."request_digest" ~ '^[a-f0-9]{64}$' AND "company_specialist_binding_revisions"."snapshot_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "company_specialist_binding_revisions_snapshot_check" CHECK ((jsonb_typeof("company_specialist_binding_revisions"."snapshot")='object' AND "company_specialist_binding_revisions"."snapshot"->'schemaVersion'='1'::jsonb AND jsonb_typeof("company_specialist_binding_revisions"."snapshot"->'definition')='object' AND jsonb_typeof("company_specialist_binding_revisions"."snapshot"->'configuration')='object' AND jsonb_typeof("company_specialist_binding_revisions"."snapshot"->'effectiveConfiguration')='object' AND jsonb_typeof("company_specialist_binding_revisions"."snapshot"->'grantActions')='array' AND jsonb_typeof("company_specialist_binding_revisions"."snapshot"->'executionPolicy')='object' AND pg_column_size("company_specialist_binding_revisions"."snapshot")<=2097152 AND jsonb_typeof("company_specialist_binding_revisions"."authority_snapshot")='object' AND "company_specialist_binding_revisions"."authority_snapshot"->'schemaVersion'='1'::jsonb AND "company_specialist_binding_revisions"."authority_snapshot"->'actor'="company_specialist_binding_revisions"."actor" AND jsonb_typeof("company_specialist_binding_revisions"."authority_snapshot"->'witness')='object' AND pg_column_size("company_specialist_binding_revisions"."authority_snapshot")<=32768) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "company_specialist_bindings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"package_install_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"detached_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"creation_key" text NOT NULL,
	"creation_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_specialist_bindings_creation_uq" UNIQUE("company_id","created_by","creation_key"),
	CONSTRAINT "company_specialist_bindings_identity_check" CHECK (char_length("company_specialist_bindings"."agent_id") BETWEEN 1 AND 192 AND "company_specialist_bindings"."agent_id" ~ '^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$' AND char_length("company_specialist_bindings"."created_by") BETWEEN 1 AND 192),
	CONSTRAINT "company_specialist_bindings_revision_check" CHECK ("company_specialist_bindings"."revision">0),
	CONSTRAINT "company_specialist_bindings_lifecycle_check" CHECK (("company_specialist_bindings"."detached_at" IS NULL AND "company_specialist_bindings"."package_install_id" IS NOT NULL) OR ("company_specialist_bindings"."detached_at" IS NOT NULL AND "company_specialist_bindings"."package_install_id" IS NULL AND "company_specialist_bindings"."enabled"=false)),
	CONSTRAINT "company_specialist_bindings_creation_check" CHECK ("company_specialist_bindings"."creation_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "company_specialist_bindings"."creation_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "company_specialist_binding_revisions" ADD CONSTRAINT "company_specialist_binding_revisions_head_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."company_specialist_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_specialist_bindings" ADD CONSTRAINT "company_specialist_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_specialist_bindings" ADD CONSTRAINT "company_specialist_bindings_package_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_specialist_bindings_live_role_uq" ON "company_specialist_bindings" USING btree ("company_id","agent_id") WHERE "company_specialist_bindings"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX "company_specialist_bindings_company_idx" ON "company_specialist_bindings" USING btree ("company_id","agent_id","id");--> statement-breakpoint
CREATE INDEX "company_specialist_bindings_package_idx" ON "company_specialist_bindings" USING btree ("package_install_id","id");
--> statement-breakpoint
CREATE FUNCTION guard_company_specialist_binding_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Accepted company specialist binding history is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_specialist_binding_history_immutable BEFORE UPDATE OR DELETE ON company_specialist_binding_revisions FOR EACH ROW EXECUTE FUNCTION guard_company_specialist_binding_history();
--> statement-breakpoint
CREATE FUNCTION guard_company_specialist_binding_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.detached_at IS NOT NULL THEN
      RAISE EXCEPTION 'Company specialist bindings begin at live configuration revision one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Retire company specialist bindings without deleting their history' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.company_id,NEW.agent_id,NEW.created_by,NEW.creation_key,NEW.creation_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.agent_id,OLD.created_by,OLD.creation_key,OLD.creation_digest,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR OLD.detached_at IS NOT NULL THEN
    RAISE EXCEPTION 'Company specialist identity is immutable and revisions advance once before retirement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_specialist_binding_head_guard BEFORE INSERT OR UPDATE OR DELETE ON company_specialist_bindings FOR EACH ROW EXECUTE FUNCTION guard_company_specialist_binding_head();
--> statement-breakpoint
CREATE FUNCTION check_company_specialist_binding_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head company_specialist_bindings;
BEGIN
  SELECT * INTO head FROM company_specialist_bindings WHERE id=NEW.binding_id;
  IF head.id IS NULL OR NEW.revision<>head.revision OR
    (NEW.revision=1) IS DISTINCT FROM (NEW.operation='created') OR
    (NEW.revision=1 AND (NEW.request_actor_id,NEW.request_key,NEW.request_digest) IS DISTINCT FROM (head.created_by,head.creation_key,head.creation_digest)) OR
    NEW.snapshot->>'agentId' IS DISTINCT FROM head.agent_id OR
    NEW.authority_snapshot->'witness'->'owner'->>'companyId' IS DISTINCT FROM head.company_id OR
    NEW.authority_snapshot->'witness'->>'action' IS DISTINCT FROM 'specialists:manage' OR
    (NEW.snapshot->>'enabled')::boolean IS DISTINCT FROM head.enabled OR
    (NEW.snapshot->>'detachedAt')::timestamptz IS DISTINCT FROM head.detached_at OR
    (head.detached_at IS NOT NULL) IS DISTINCT FROM (NEW.operation='detached') OR
    (head.detached_at IS NULL AND NEW.snapshot->>'packageInstallId' IS DISTINCT FROM head.package_install_id) THEN
    RAISE EXCEPTION 'Company specialist revision must describe its exact owned head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_specialist_binding_revision_guard BEFORE INSERT ON company_specialist_binding_revisions FOR EACH ROW EXECUTE FUNCTION check_company_specialist_binding_revision();
--> statement-breakpoint
CREATE FUNCTION check_company_specialist_binding_head_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head company_specialist_bindings;
BEGIN
  SELECT * INTO head FROM company_specialist_bindings WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM company_specialist_binding_revisions WHERE binding_id=head.id AND revision=head.revision) THEN
    RAISE EXCEPTION 'Company specialist head requires its immutable configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER company_specialist_binding_head_revision_guard AFTER INSERT OR UPDATE ON company_specialist_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_company_specialist_binding_head_revision();
