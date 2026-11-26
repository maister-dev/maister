CREATE TABLE "project_dependency_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"declaration_id" text NOT NULL,
	"generation" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"desired" jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"stage" text,
	"reason" text,
	"resolved_revision" text,
	"member_ref" text,
	"retry_of_attempt_id" text,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_attempt_number_uq" UNIQUE("declaration_id","generation","attempt_no"),
	CONSTRAINT "dependency_attempt_owner_generation_uq" UNIQUE("declaration_id","generation","id"),
	CONSTRAINT "dependency_retry_receipt_uq" UNIQUE("retry_of_attempt_id"),
	CONSTRAINT "dependency_attempt_shape" CHECK (
      "project_dependency_attempts"."generation" >= 1 AND "project_dependency_attempts"."attempt_no" >= 1
      AND "project_dependency_attempts"."status" IN ('pending','running','failed','succeeded','recovery_required')
      AND ("project_dependency_attempts"."status" = 'running') = ("project_dependency_attempts"."claim_token" IS NOT NULL)
      AND ("project_dependency_attempts"."status" = 'running') = ("project_dependency_attempts"."lease_expires_at" IS NOT NULL)
      AND ("project_dependency_attempts"."stage" IS NULL OR "project_dependency_attempts"."stage" IN ('resolve','install','attach','setup','projection'))
      AND ("project_dependency_attempts"."reason" IS NULL OR length("project_dependency_attempts"."reason") BETWEEN 1 AND 512)
      AND ("project_dependency_attempts"."status" NOT IN ('failed','recovery_required') OR ("project_dependency_attempts"."reason" IS NOT NULL AND "project_dependency_attempts"."stage" IS NOT NULL))
      AND ("project_dependency_attempts"."status" <> 'recovery_required' OR ("project_dependency_attempts"."stage" = 'setup' AND "project_dependency_attempts"."member_ref" IS NOT NULL AND "project_dependency_attempts"."resolved_revision" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "project_dependency_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"logical_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"desired" jsonb NOT NULL,
	"effective_attachment_id" text,
	"effective_revision" text,
	"effective_generation" integer,
	CONSTRAINT "dependency_head_owner_uq" UNIQUE("project_id","id"),
	CONSTRAINT "dependency_effective_attachment_uq" UNIQUE("effective_attachment_id"),
	CONSTRAINT "dependency_head_shape" CHECK (
      "project_dependency_declarations"."kind" IN ('package','flow','capability_import') AND length("project_dependency_declarations"."logical_id") > 0 AND "project_dependency_declarations"."ordinal" >= 0 AND "project_dependency_declarations"."generation" >= 1
      AND jsonb_typeof("project_dependency_declarations"."desired") = 'object' AND "project_dependency_declarations"."desired" ?& ARRAY['source','version']
      AND jsonb_typeof("project_dependency_declarations"."desired"->'source') = 'string' AND length("project_dependency_declarations"."desired"->>'source') > 0
      AND jsonb_typeof("project_dependency_declarations"."desired"->'version') = 'string' AND length("project_dependency_declarations"."desired"->>'version') > 0
      AND ("project_dependency_declarations"."effective_generation" IS NULL) = ("project_dependency_declarations"."effective_revision" IS NULL)
      AND ("project_dependency_declarations"."effective_generation" IS NULL OR "project_dependency_declarations"."effective_generation" BETWEEN 1 AND "project_dependency_declarations"."generation")
      AND ("project_dependency_declarations"."effective_attachment_id" IS NULL OR ("project_dependency_declarations"."kind" = 'package' AND "project_dependency_declarations"."effective_revision" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "project_dependency_setup_receipts" (
	"material_key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"claim_token" text NOT NULL,
	"owner_host" text,
	"owner_pid" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_setup_shape" CHECK ("project_dependency_setup_receipts"."status" IN ('running','succeeded','failed') AND ("project_dependency_setup_receipts"."owner_pid" IS NULL OR "project_dependency_setup_receipts"."owner_pid" > 0))
);
--> statement-breakpoint
ALTER TABLE "project_package_attachments" ADD CONSTRAINT "project_package_attachments_owner_id_uq" UNIQUE("project_id","id");
--> statement-breakpoint
ALTER TABLE "project_dependency_attempts" ADD CONSTRAINT "project_dependency_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dependency_attempts" ADD CONSTRAINT "dependency_attempt_owner_fk" FOREIGN KEY ("project_id","declaration_id") REFERENCES "public"."project_dependency_declarations"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dependency_attempts" ADD CONSTRAINT "dependency_retry_owner_fk" FOREIGN KEY ("declaration_id","generation","retry_of_attempt_id") REFERENCES "public"."project_dependency_attempts"("declaration_id","generation","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dependency_declarations" ADD CONSTRAINT "project_dependency_declarations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dependency_declarations" ADD CONSTRAINT "dependency_attachment_owner_fk" FOREIGN KEY ("project_id","effective_attachment_id") REFERENCES "public"."project_package_attachments"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_single_claim_uq" ON "project_dependency_attempts" USING btree ("declaration_id") WHERE "project_dependency_attempts"."status" = 'running';--> statement-breakpoint
CREATE INDEX "dependency_attempt_due_idx" ON "project_dependency_attempts" USING btree ("due_at","project_id") WHERE "project_dependency_attempts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "dependency_attempt_expiry_idx" ON "project_dependency_attempts" USING btree ("lease_expires_at") WHERE "project_dependency_attempts"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_flow_namespace_uq" ON "project_dependency_declarations" USING btree ("project_id","logical_id") WHERE "project_dependency_declarations"."kind" IN ('flow','package');--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_import_namespace_uq" ON "project_dependency_declarations" USING btree ("project_id","logical_id") WHERE "project_dependency_declarations"."kind" IN ('capability_import','package');--> statement-breakpoint
DO $$
DECLARE bad_attachment text;
BEGIN
  SELECT a.id INTO bad_attachment
  FROM project_package_attachments a LEFT JOIN package_installs i ON i.id = a.package_install_id
  WHERE i.id IS NULL OR i.name <> a.package_name OR i.package_status <> 'Installed'
    OR i.name = '' OR i.source_url = '' OR i.version_label = '' OR i.resolved_revision = ''
    OR jsonb_typeof(i.manifest) <> 'object'
    OR (i.manifest ? 'sourceSubpath' AND jsonb_typeof(i.manifest->'sourceSubpath') <> 'string')
  ORDER BY a.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Repair attachment % before upgrading project dependencies', bad_attachment USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO project_dependency_declarations
  (id, project_id, kind, logical_id, ordinal, desired, effective_revision, effective_generation, effective_attachment_id)
SELECT gen_random_uuid()::text, a.project_id, 'package', i.name,
  row_number() OVER (PARTITION BY a.project_id ORDER BY i.name, a.id) - 1,
  jsonb_strip_nulls(jsonb_build_object('source', i.source_url, 'version', i.version_label, 'path', i.manifest->>'sourceSubpath')),
  i.resolved_revision, 1, a.id
FROM project_package_attachments a JOIN package_installs i ON i.id = a.package_install_id;
--> statement-breakpoint
DROP TRIGGER project_config_install_before_update ON package_installs;
--> statement-breakpoint
DROP FUNCTION project_config_install_revision();
--> statement-breakpoint
DROP TRIGGER project_config_attachment_after_change ON project_package_attachments;
--> statement-breakpoint
DROP FUNCTION project_config_attachment_revision();
--> statement-breakpoint
DROP TRIGGER project_config_attachment_before_binding_change ON project_package_attachments;
--> statement-breakpoint
DROP FUNCTION project_config_lock_attachment_installs();
--> statement-breakpoint
CREATE FUNCTION project_dependency_guard_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.kind,NEW.logical_id,NEW.ordinal)
     IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.kind,OLD.logical_id,OLD.ordinal)
     OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation + 1
     OR (NEW.desired <> OLD.desired AND NEW.generation = OLD.generation) THEN
    RAISE EXCEPTION 'Invalid project dependency generation or identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_dependency_head_before_update BEFORE UPDATE ON project_dependency_declarations
FOR EACH ROW EXECUTE FUNCTION project_dependency_guard_head();
--> statement-breakpoint
CREATE FUNCTION project_config_declaration_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'package' THEN
      UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = OLD.project_id;
    END IF;
  ELSIF NEW.kind = 'package' AND (TG_OP = 'INSERT' OR
        ROW(NEW.desired->'source',NEW.desired->'version',NEW.desired->'path')
        IS DISTINCT FROM ROW(OLD.desired->'source',OLD.desired->'version',OLD.desired->'path')) THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = NEW.project_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_declaration_after_change AFTER INSERT OR UPDATE OR DELETE ON project_dependency_declarations
FOR EACH ROW EXECUTE FUNCTION project_config_declaration_revision();
--> statement-breakpoint
CREATE FUNCTION project_dependency_guard_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM id FROM project_dependency_declarations
      WHERE id = NEW.declaration_id AND project_id = NEW.project_id AND generation = NEW.generation AND desired = NEW.desired
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dependency attempt does not match its current declaration' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.project_id,NEW.declaration_id,NEW.generation,NEW.attempt_no,NEW.desired,NEW.actor_user_id,NEW.retry_of_attempt_id,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.declaration_id,OLD.generation,OLD.attempt_no,OLD.desired,OLD.actor_user_id,OLD.retry_of_attempt_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Dependency attempt authorization and input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_dependency_attempt_before_write BEFORE INSERT OR UPDATE ON project_dependency_attempts
FOR EACH ROW EXECUTE FUNCTION project_dependency_guard_attempt();
