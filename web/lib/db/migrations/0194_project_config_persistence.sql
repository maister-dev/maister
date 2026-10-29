CREATE TABLE "project_config_persist_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"repository_key" text NOT NULL,
	"state" text DEFAULT 'previewed' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"owner_token" text,
	"owner_process_id" integer,
	"prepared_sha" text,
	"committed_sha" text,
	"completed_at" timestamp with time zone,
	"error_reason" text,
	"used_default_author" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_config_persist_identity_uq" UNIQUE("id","project_id","actor_user_id"),
	CONSTRAINT "project_config_persist_state_check" CHECK ("project_config_persist_operations"."state" IN ('previewed','preparing','prepared','publishing','committed','noop','stale','failed','recovery_required')),
	CONSTRAINT "project_config_persist_digest_check" CHECK ("project_config_persist_operations"."snapshot_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_config_persist_receipt_check" CHECK (
      ("project_config_persist_operations"."state" NOT IN ('preparing','prepared','publishing','committed','recovery_required') OR "project_config_persist_operations"."accepted_at" IS NOT NULL)
      AND ("project_config_persist_operations"."state" NOT IN ('prepared','publishing','committed') OR "project_config_persist_operations"."prepared_sha" IS NOT NULL)
      AND ("project_config_persist_operations"."state" <> 'committed' OR ("project_config_persist_operations"."committed_sha" IS NOT NULL AND "project_config_persist_operations"."completed_at" IS NOT NULL))
      AND ("project_config_persist_operations"."state" NOT IN ('noop','stale','failed') OR "project_config_persist_operations"."completed_at" IS NOT NULL)
      AND ("project_config_persist_operations"."state" NOT IN ('stale','failed','recovery_required') OR "project_config_persist_operations"."error_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "project_config_push_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"state" text DEFAULT 'previewed' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_config_push_state_check" CHECK ("project_config_push_intents"."state" IN ('previewed','pending','succeeded','failed','unknown','stale')),
	CONSTRAINT "project_config_push_digest_check" CHECK ("project_config_push_intents"."snapshot_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_config_push_receipt_check" CHECK (
      ("project_config_push_intents"."state" NOT IN ('pending','succeeded','failed','unknown') OR "project_config_push_intents"."accepted_at" IS NOT NULL)
      AND ("project_config_push_intents"."state" NOT IN ('succeeded','failed','stale') OR "project_config_push_intents"."completed_at" IS NOT NULL)
      AND ("project_config_push_intents"."state" NOT IN ('failed','unknown','stale') OR "project_config_push_intents"."error_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "config_export_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_config_persist_operations" ADD CONSTRAINT "project_config_persist_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_persist_operations" ADD CONSTRAINT "project_config_persist_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD CONSTRAINT "project_config_push_operation_identity_fk" FOREIGN KEY ("operation_id","project_id","actor_user_id") REFERENCES "public"."project_config_persist_operations"("id","project_id","actor_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_config_persist_active_repo_uq" ON "project_config_persist_operations" USING btree ("repository_key") WHERE "project_config_persist_operations"."state" IN ('preparing', 'prepared', 'publishing', 'recovery_required');--> statement-breakpoint
CREATE INDEX "project_config_persist_project_created_idx" ON "project_config_persist_operations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_config_persist_recovery_idx" ON "project_config_persist_operations" USING btree ("state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_config_push_active_destination_uq" ON "project_config_push_intents" USING btree ("operation_id",("snapshot"->>'destinationFingerprint')) WHERE "project_config_push_intents"."state" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX "project_config_push_operation_created_idx" ON "project_config_push_intents" USING btree ("operation_id","created_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_config_export_revision_check" CHECK ("projects"."config_export_revision" >= 0);--> statement-breakpoint
CREATE FUNCTION project_config_advance_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.name, NEW.main_branch, NEW.branch_prefix, NEW.public_branch_template,
         NEW.default_runner_id, NEW.promotion_mode)
     IS DISTINCT FROM
     ROW(OLD.name, OLD.main_branch, OLD.branch_prefix, OLD.public_branch_template,
         OLD.default_runner_id, OLD.promotion_mode) THEN
    NEW.config_export_revision := OLD.config_export_revision + 1;
  ELSIF NEW.config_export_revision < OLD.config_export_revision THEN
    RAISE EXCEPTION 'project config export revision cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_revision_before_update
BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION project_config_advance_revision();
--> statement-breakpoint
CREATE FUNCTION project_config_attachment_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = NEW.project_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = OLD.project_id;
  ELSIF ROW(NEW.project_id, NEW.package_install_id, NEW.package_name)
        IS DISTINCT FROM ROW(OLD.project_id, OLD.package_install_id, OLD.package_name) THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1
    WHERE id IN (OLD.project_id, NEW.project_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_attachment_after_change
AFTER INSERT OR UPDATE OR DELETE ON project_package_attachments
FOR EACH ROW EXECUTE FUNCTION project_config_attachment_revision();
--> statement-breakpoint
CREATE FUNCTION project_config_guard_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
BEGIN
  IF ROW(NEW.id, NEW.project_id, NEW.actor_user_id, NEW.snapshot, NEW.snapshot_digest, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.project_id, OLD.actor_user_id, OLD.snapshot, OLD.snapshot_digest, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'project configuration review is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'accepted configuration intent is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'project_config_persist_operations' THEN
    IF NEW.repository_key IS DISTINCT FROM OLD.repository_key
       OR (OLD.prepared_sha IS NOT NULL AND NEW.prepared_sha IS DISTINCT FROM OLD.prepared_sha)
       OR (OLD.committed_sha IS NOT NULL AND NEW.committed_sha IS DISTINCT FROM OLD.committed_sha) THEN
      RAISE EXCEPTION 'project configuration provenance is immutable' USING ERRCODE = '23514';
    END IF;
    allowed := NEW.state = OLD.state OR CASE OLD.state
      WHEN 'previewed' THEN NEW.state IN ('preparing','noop','stale','failed')
      WHEN 'preparing' THEN NEW.state IN ('prepared','failed','stale','recovery_required')
      WHEN 'prepared' THEN NEW.state IN ('publishing','stale','recovery_required')
      WHEN 'publishing' THEN NEW.state IN ('committed','recovery_required')
      WHEN 'recovery_required' THEN NEW.state IN ('prepared','publishing','committed','failed','stale')
      ELSE false END;
  ELSE
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
      RAISE EXCEPTION 'project configuration push parent is immutable' USING ERRCODE = '23514';
    END IF;
    allowed := NEW.state = OLD.state OR CASE OLD.state
      WHEN 'previewed' THEN NEW.state IN ('pending','stale')
      WHEN 'pending' THEN NEW.state IN ('succeeded','failed','unknown')
      WHEN 'unknown' THEN NEW.state IN ('succeeded','failed','stale')
      ELSE false END;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'project configuration transition % -> % is not allowed', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_persist_guard_before_update
BEFORE UPDATE ON project_config_persist_operations
FOR EACH ROW EXECUTE FUNCTION project_config_guard_intent();
--> statement-breakpoint
CREATE TRIGGER project_config_push_guard_before_update
BEFORE UPDATE ON project_config_push_intents
FOR EACH ROW EXECUTE FUNCTION project_config_guard_intent();
