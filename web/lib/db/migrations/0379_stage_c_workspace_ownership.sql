ALTER TABLE "workspaces" ALTER COLUMN "worktree_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "parent_repo_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_execution_host_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "execution_host_preference_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD COLUMN "requested_execution_host_id" text;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD COLUMN "effective_execution_host_id" text;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD COLUMN "execution_host_provenance" text;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD COLUMN "execution_host_eligibility_revision" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ownership_kind" text DEFAULT 'legacy_path' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_host_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preparation_assignment_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workspace_generation" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workspace_input_digest" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "root_workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "legacy_host_adoption_issue" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("default_execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_requested_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("requested_execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_effective_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("effective_execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_workspace_owner_uq" UNIQUE("id","run_id","execution_host_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_host_scoped_identity_uq" UNIQUE("id","execution_host_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_preparation_assignment_fk" FOREIGN KEY ("preparation_assignment_id","run_id","execution_host_id") REFERENCES "public"."execution_assignments"("id","run_id","execution_host_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_root_host_fk" FOREIGN KEY ("root_workspace_id","execution_host_id") REFERENCES "public"."workspaces"("id","execution_host_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_active_host_handle_uq" ON "workspaces" USING btree ("execution_host_id","execution_workspace_id") WHERE "workspaces"."removed_at" IS NULL AND "workspaces"."execution_workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_active_host_run_uq" ON "workspaces" USING btree ("run_id") WHERE "workspaces"."removed_at" IS NULL AND "workspaces"."ownership_kind" = 'host_owned';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_execution_host_preference_revision_check" CHECK ("projects"."execution_host_preference_revision" BETWEEN 1 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_host_selection_shape_check" CHECK ((
        ("task_launch_intents"."requested_execution_host_id" IS NULL AND "task_launch_intents"."effective_execution_host_id" IS NULL
          AND "task_launch_intents"."execution_host_provenance" IS NULL AND "task_launch_intents"."execution_host_eligibility_revision" IS NULL)
        OR
        ("task_launch_intents"."effective_execution_host_id" IS NOT NULL
          AND "task_launch_intents"."execution_host_eligibility_revision" ~ '^[0-9a-f]{64}$'
          AND (("task_launch_intents"."execution_host_provenance" = 'explicit'
              AND "task_launch_intents"."requested_execution_host_id" = "task_launch_intents"."effective_execution_host_id")
            OR ("task_launch_intents"."execution_host_provenance" IN ('projectDefault', 'instanceDefault', 'sharedRoot')
              AND "task_launch_intents"."requested_execution_host_id" IS NULL)))
      ) IS TRUE);--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_host_ownership_shape_check" CHECK ((
        ("workspaces"."ownership_kind" = 'legacy_path'
          AND "workspaces"."worktree_path" IS NOT NULL AND "workspaces"."parent_repo_path" IS NOT NULL
          AND "workspaces"."execution_host_id" IS NULL AND "workspaces"."execution_workspace_id" IS NULL
          AND "workspaces"."preparation_assignment_id" IS NULL AND "workspaces"."workspace_generation" IS NULL
          AND "workspaces"."workspace_input_digest" IS NULL AND "workspaces"."root_workspace_id" IS NULL
          AND ("workspaces"."legacy_host_adoption_issue" IS NULL OR "workspaces"."legacy_host_adoption_issue" = 'owner_unverified'))
        OR
        ("workspaces"."ownership_kind" = 'host_owned'
          AND "workspaces"."worktree_path" IS NULL AND "workspaces"."parent_repo_path" IS NULL
          AND "workspaces"."execution_host_id" IS NOT NULL AND "workspaces"."preparation_assignment_id" IS NOT NULL
          AND "workspaces"."legacy_host_adoption_issue" IS NULL
          AND "workspaces"."workspace_generation" > 0 AND "workspaces"."workspace_input_digest" ~ '^[0-9a-f]{64}$'
          AND ("workspaces"."execution_workspace_id" IS NULL OR "workspaces"."execution_workspace_id" ~ '^ws_[0-9a-f]{32}$')
          AND ("workspaces"."root_workspace_id" IS NULL
            OR ("workspaces"."root_workspace_id" <> "workspaces"."id" AND "workspaces"."execution_workspace_id" IS NULL)))
      ) IS TRUE);--> statement-breakpoint
-- This records an unresolved locator. Checkout identity still requires owning-host verification.
UPDATE workspaces w
SET legacy_host_adoption_issue = 'owner_unverified'
WHERE w.ownership_kind = 'legacy_path'
  AND w.legacy_host_adoption_issue IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM runs r
    JOIN execution_assignments a ON a.id = r.execution_assignment_id AND a.run_id = r.id
    WHERE r.id = w.run_id AND a.execution_workspace_id ~ '^ws_[0-9a-f]{32}$'
      AND NOT EXISTS (
        SELECT 1 FROM execution_assignments alternative
        WHERE alternative.run_id = r.id
          AND alternative.execution_host_id <> a.execution_host_id
          AND alternative.execution_workspace_id IS NOT NULL
      )
  );--> statement-breakpoint
CREATE FUNCTION guard_task_launch_host_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.requested_execution_host_id, OLD.effective_execution_host_id,
         OLD.execution_host_provenance, OLD.execution_host_eligibility_revision)
     IS DISTINCT FROM
     ROW(NEW.requested_execution_host_id, NEW.effective_execution_host_id,
         NEW.execution_host_provenance, NEW.execution_host_eligibility_revision) THEN
    RAISE EXCEPTION 'Accepted execution host selection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'task_launch_intents_host_selection_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER task_launch_intents_host_selection_guard
  BEFORE UPDATE OF requested_execution_host_id, effective_execution_host_id,
    execution_host_provenance, execution_host_eligibility_revision
  ON task_launch_intents FOR EACH ROW EXECUTE FUNCTION guard_task_launch_host_selection();
