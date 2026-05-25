import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  mainBranch: text("main_branch").notNull().default("main"),
  branchPrefix: text("branch_prefix").notNull().default("maister/"),
  maisterYamlPath: text("maister_yaml_path").notNull(),
  defaultExecutorId: text("default_executor_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
});

export const executors = pgTable(
  "executors",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    executorRefId: text("executor_ref_id").notNull(),
    agent: text("agent", { enum: ["claude", "codex"] }).notNull(),
    model: text("model").notNull(),
    env: jsonb("env").$type<Record<string, string> | null>(),
    router: text("router", { enum: ["ccr"] }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqExecutorRefPerProject: unique("executors_project_ref_uq").on(
      t.projectId,
      t.executorRefId,
    ),
  }),
);

export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowRefId: text("flow_ref_id").notNull(),
    source: text("source").notNull(),
    version: text("version").notNull(),
    installedPath: text("installed_path").notNull(),
    manifest: jsonb("manifest").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    recommendedExecutorId: text("recommended_executor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqFlowRefPerProject: unique("flows_project_ref_uq").on(
      t.projectId,
      t.flowRefId,
    ),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    executorOverrideId: text("executor_override_id").references(
      () => executors.id,
    ),
    status: text("status", {
      enum: ["Backlog", "InFlight", "Done", "Abandoned"],
    })
      .notNull()
      .default("Backlog"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAttempt: unique("tasks_id_attempt_uq").on(t.id, t.attemptNumber),
    idxProjectStatus: index("tasks_project_status_idx").on(
      t.projectId,
      t.status,
    ),
  }),
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    executorId: text("executor_id")
      .notNull()
      .references(() => executors.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "Pending",
        "Running",
        "NeedsInput",
        "NeedsInputIdle",
        "Review",
        "Crashed",
        "Done",
        "Abandoned",
        "Failed",
      ],
    })
      .notNull()
      .default("Pending"),
    acpSessionId: text("acp_session_id"),
    flowVersion: text("flow_version").notNull(),
    checkpointAt: timestamp("checkpoint_at", {
      withTimezone: true,
      mode: "date",
    }),
    keepaliveUntil: timestamp("keepalive_until", {
      withTimezone: true,
      mode: "date",
    }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxProjectStatus: index("runs_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    idxTask: index("runs_task_idx").on(t.taskId),
  }),
);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull().unique(),
  parentRepoPath: text("parent_repo_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
});

export const hitlRequests = pgTable(
  "hitl_requests",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    kind: text("kind", { enum: ["permission", "form", "human"] }).notNull(),
    schema: jsonb("schema"),
    prompt: text("prompt").notNull(),
    response: jsonb("response"),
    respondedAt: timestamp("responded_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxRun: index("hitl_requests_run_idx").on(t.runId),
  }),
);

export type Project = typeof projects.$inferSelect;
export type Executor = typeof executors.$inferSelect;
export type Flow = typeof flows.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type HitlRequest = typeof hitlRequests.$inferSelect;
