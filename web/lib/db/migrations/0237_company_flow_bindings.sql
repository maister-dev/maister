CREATE TABLE "company_flow_binding_revisions" (
	"binding_id" text NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"authority_snapshot" jsonb NOT NULL,
	"request_actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_flow_binding_revisions_binding_id_revision_pk" PRIMARY KEY("binding_id","revision"),
	CONSTRAINT "company_flow_binding_revisions_request_uq" UNIQUE("binding_id","request_actor_id","request_key"),
	CONSTRAINT "company_flow_binding_revisions_version_check" CHECK ("company_flow_binding_revisions"."revision">0 AND "company_flow_binding_revisions"."operation" IN ('created','updated','detached')),
	CONSTRAINT "company_flow_binding_revisions_receipt_check" CHECK (char_length("company_flow_binding_revisions"."request_actor_id") BETWEEN 1 AND 192 AND "company_flow_binding_revisions"."request_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "company_flow_binding_revisions"."request_digest" ~ '^[a-f0-9]{64}$' AND "company_flow_binding_revisions"."snapshot_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "company_flow_binding_revisions_snapshot_check" CHECK ((jsonb_typeof("company_flow_binding_revisions"."snapshot")='object' AND "company_flow_binding_revisions"."snapshot"->'schemaVersion'='1'::jsonb AND jsonb_typeof("company_flow_binding_revisions"."snapshot"->'manifest')='object' AND jsonb_typeof("company_flow_binding_revisions"."snapshot"->'specialist')='object' AND jsonb_typeof("company_flow_binding_revisions"."snapshot"->'roleMappings')='object' AND "company_flow_binding_revisions"."snapshot"->'execution'='{"workspace":"none","completion":"result"}'::jsonb AND pg_column_size("company_flow_binding_revisions"."snapshot")<=4194304 AND jsonb_typeof("company_flow_binding_revisions"."authority_snapshot")='object' AND "company_flow_binding_revisions"."authority_snapshot"->'schemaVersion'='1'::jsonb AND "company_flow_binding_revisions"."authority_snapshot"->'actor'->>'kind'='user' AND "company_flow_binding_revisions"."authority_snapshot"->'actor'->>'id'="company_flow_binding_revisions"."request_actor_id" AND "company_flow_binding_revisions"."authority_snapshot"->'actor'->'runId'='null'::jsonb AND "company_flow_binding_revisions"."authority_snapshot"->'actor'->'attemptId'='null'::jsonb AND pg_column_size("company_flow_binding_revisions"."authority_snapshot")<=32768) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "company_flow_bindings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"company_id" text NOT NULL,
	"flow_ref_id" text NOT NULL,
	"flow_revision_id" text,
	"package_install_id" text,
	"specialist_binding_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"detached_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"creation_key" text NOT NULL,
	"creation_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_flow_bindings_creation_uq" UNIQUE("company_id","created_by","creation_key"),
	CONSTRAINT "company_flow_bindings_identity_check" CHECK (char_length("company_flow_bindings"."flow_ref_id") BETWEEN 1 AND 128 AND char_length("company_flow_bindings"."created_by") BETWEEN 1 AND 192 AND "company_flow_bindings"."revision">0),
	CONSTRAINT "company_flow_bindings_lifecycle_check" CHECK (("company_flow_bindings"."detached_at" IS NULL AND "company_flow_bindings"."flow_revision_id" IS NOT NULL AND "company_flow_bindings"."package_install_id" IS NOT NULL AND "company_flow_bindings"."specialist_binding_id" IS NOT NULL) OR ("company_flow_bindings"."detached_at" IS NOT NULL AND "company_flow_bindings"."flow_revision_id" IS NULL AND "company_flow_bindings"."package_install_id" IS NULL AND "company_flow_bindings"."specialist_binding_id" IS NULL AND "company_flow_bindings"."enabled"=false)),
	CONSTRAINT "company_flow_bindings_creation_check" CHECK ("company_flow_bindings"."creation_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "company_flow_bindings"."creation_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "company_flow_binding_revisions" ADD CONSTRAINT "company_flow_binding_revisions_head_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."company_flow_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flow_bindings" ADD CONSTRAINT "company_flow_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flow_bindings" ADD CONSTRAINT "company_flow_bindings_flow_fk" FOREIGN KEY ("flow_revision_id") REFERENCES "public"."flow_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flow_bindings" ADD CONSTRAINT "company_flow_bindings_package_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flow_bindings" ADD CONSTRAINT "company_flow_bindings_specialist_fk" FOREIGN KEY ("specialist_binding_id") REFERENCES "public"."company_specialist_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_flow_bindings_live_flow_uq" ON "company_flow_bindings" USING btree ("company_id","flow_ref_id") WHERE "company_flow_bindings"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX "company_flow_bindings_company_idx" ON "company_flow_bindings" USING btree ("company_id","flow_ref_id","id");--> statement-breakpoint
CREATE INDEX "company_flow_bindings_flow_idx" ON "company_flow_bindings" USING btree ("flow_revision_id");--> statement-breakpoint
CREATE INDEX "company_flow_bindings_package_idx" ON "company_flow_bindings" USING btree ("package_install_id");--> statement-breakpoint
CREATE INDEX "company_flow_bindings_specialist_idx" ON "company_flow_bindings" USING btree ("specialist_binding_id");
--> statement-breakpoint
CREATE FUNCTION guard_company_flow_binding_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Accepted company Flow configuration history is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_flow_binding_history_immutable BEFORE UPDATE OR DELETE ON company_flow_binding_revisions FOR EACH ROW EXECUTE FUNCTION guard_company_flow_binding_history();
--> statement-breakpoint
CREATE FUNCTION guard_company_flow_binding_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Retire company Flow bindings without deleting accepted history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.detached_at IS NOT NULL THEN
      RAISE EXCEPTION 'Company Flow bindings begin at live configuration revision one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.company_id,NEW.flow_ref_id,NEW.created_by,NEW.creation_key,NEW.creation_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.flow_ref_id,OLD.created_by,OLD.creation_key,OLD.creation_digest,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR OLD.detached_at IS NOT NULL THEN
    RAISE EXCEPTION 'Company Flow identity is immutable and revisions advance once before retirement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_flow_binding_head_guard BEFORE INSERT OR UPDATE OR DELETE ON company_flow_bindings FOR EACH ROW EXECUTE FUNCTION guard_company_flow_binding_head();
--> statement-breakpoint
CREATE FUNCTION check_company_flow_binding_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head company_flow_bindings;
BEGIN
  SELECT * INTO head FROM company_flow_bindings WHERE id=NEW.binding_id;
  IF head.id IS NULL OR NEW.revision<>head.revision OR
    (NEW.revision=1) IS DISTINCT FROM (NEW.operation='created') OR
    (NEW.revision=1 AND (NEW.request_actor_id,NEW.request_key,NEW.request_digest) IS DISTINCT FROM (head.created_by,head.creation_key,head.creation_digest)) OR
    NEW.snapshot->>'companyId' IS DISTINCT FROM head.company_id OR
    NEW.snapshot->>'flowRefId' IS DISTINCT FROM head.flow_ref_id OR
    NEW.authority_snapshot->'witness'->'owner'->>'companyId' IS DISTINCT FROM head.company_id OR
    NEW.authority_snapshot->'witness'->>'action' IS DISTINCT FROM 'specialists:manage' OR
    (NEW.snapshot->>'enabled')::boolean IS DISTINCT FROM head.enabled OR
    (NEW.snapshot->>'detachedAt')::timestamptz IS DISTINCT FROM head.detached_at OR
    (head.detached_at IS NOT NULL) IS DISTINCT FROM (NEW.operation='detached') OR
    (head.detached_at IS NULL AND (NEW.snapshot->>'flowRevisionId',NEW.snapshot->>'packageInstallId',NEW.snapshot->>'specialistBindingId') IS DISTINCT FROM (head.flow_revision_id,head.package_install_id,head.specialist_binding_id)) THEN
    RAISE EXCEPTION 'Company Flow revision must describe its exact owned head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_flow_binding_revision_guard BEFORE INSERT ON company_flow_binding_revisions FOR EACH ROW EXECUTE FUNCTION check_company_flow_binding_revision();
--> statement-breakpoint
CREATE FUNCTION check_company_flow_binding_head_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head company_flow_bindings;
BEGIN
  SELECT * INTO head FROM company_flow_bindings WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM company_flow_binding_revisions WHERE binding_id=head.id AND revision=head.revision) THEN
    RAISE EXCEPTION 'Company Flow head requires its immutable configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER company_flow_binding_head_revision_guard AFTER INSERT OR UPDATE ON company_flow_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_company_flow_binding_head_revision();
