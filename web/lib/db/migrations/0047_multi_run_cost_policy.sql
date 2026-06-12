ALTER TABLE "projects"
  ADD COLUMN "delivery_policy_default" jsonb;

ALTER TABLE "runs"
  ADD COLUMN "delivery_policy_snapshot" jsonb;

CREATE TABLE "run_cost_rollups" (
  "run_id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "task_id" text,
  "flow_id" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "cache_creation_tokens" integer DEFAULT 0 NOT NULL,
  "resume_input_tokens" integer DEFAULT 0 NOT NULL,
  "resume_output_tokens" integer DEFAULT 0 NOT NULL,
  "resume_cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "resume_cache_creation_tokens" integer DEFAULT 0 NOT NULL,
  "by_model" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_event_count" integer DEFAULT 0 NOT NULL,
  "source_cursor" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_cost_rollups_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade,
  CONSTRAINT "run_cost_rollups_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
  CONSTRAINT "run_cost_rollups_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null,
  CONSTRAINT "run_cost_rollups_flow_id_flows_id_fk"
    FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE set null
);

CREATE INDEX "run_cost_rollups_project_flow_idx"
  ON "run_cost_rollups" ("project_id", "flow_id");

CREATE TABLE "node_attempt_cost_rollups" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "project_id" text NOT NULL,
  "node_attempt_id" text NOT NULL,
  "node_id" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "cache_creation_tokens" integer DEFAULT 0 NOT NULL,
  "resume_input_tokens" integer DEFAULT 0 NOT NULL,
  "resume_output_tokens" integer DEFAULT 0 NOT NULL,
  "resume_cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "resume_cache_creation_tokens" integer DEFAULT 0 NOT NULL,
  "source_event_count" integer DEFAULT 0 NOT NULL,
  "source_cursor" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "node_attempt_cost_rollups_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade,
  CONSTRAINT "node_attempt_cost_rollups_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
  CONSTRAINT "node_attempt_cost_rollups_node_attempt_id_node_attempts_id_fk"
    FOREIGN KEY ("node_attempt_id") REFERENCES "node_attempts"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX "node_attempt_cost_rollups_attempt_model_uq"
  ON "node_attempt_cost_rollups" ("node_attempt_id", "model");

CREATE INDEX "node_attempt_cost_rollups_run_attempt_idx"
  ON "node_attempt_cost_rollups" ("run_id", "node_attempt_id");
