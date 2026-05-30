import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", {
      withTimezone: true,
      mode: "date",
    }),
    image: text("image"),
    passwordHash: text("password_hash"),
    role: text("role", { enum: ["admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    accountStatus: text("account_status", {
      enum: ["pending", "active", "disabled"],
    })
      .notNull()
      .default("pending"),
    accountStatusUpdatedAt: timestamp("account_status_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    accountStatusUpdatedBy: text("account_status_updated_by"),
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxAccountStatus: index("users_account_status_idx").on(t.accountStatus),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  }),
);

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
    revision: text("revision").notNull().default("unknown"),
    installedPath: text("installed_path").notNull(),
    manifest: jsonb("manifest").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    recommendedExecutorId: text("recommended_executor_id"),
    executorOverrideId: text("executor_override_id").references(
      () => executors.id,
      { onDelete: "set null" },
    ),
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
    stage: text("stage", { enum: ["Backlog", "Prepare"] })
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
    currentStepId: text("current_step_id"),
    flowVersion: text("flow_version").notNull(),
    flowRevision: text("flow_revision").notNull().default("unknown"),
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

export const stepRuns = pgTable(
  "step_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    stepType: text("step_type", {
      enum: ["cli", "agent", "guard", "human"],
    }).notNull(),
    mode: text("mode", { enum: ["new-session", "slash-in-existing"] }),
    attempt: integer("attempt").notNull().default(1),
    status: text("status", {
      enum: [
        "Pending",
        "Running",
        "Succeeded",
        "Failed",
        "Skipped",
        "NeedsInput",
      ],
    })
      .notNull()
      .default("Pending"),
    acpSessionId: text("acp_session_id"),
    stdout: text("stdout"),
    vars: jsonb("vars").$type<Record<string, unknown>>().notNull().default({}),
    exitCode: integer("exit_code"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    uniqRunStepAttempt: unique("step_runs_run_step_attempt_uq").on(
      t.runId,
      t.stepId,
      t.attempt,
    ),
    idxRun: index("step_runs_run_idx").on(t.runId),
  }),
);

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

export const projectMembers = pgTable(
  "project_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["owner", "admin", "member", "viewer"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqMembership: unique("project_members_project_user_uq").on(
      t.projectId,
      t.userId,
    ),
    idxUser: index("project_members_user_idx").on(t.userId),
  }),
);

export type User = typeof users.$inferSelect;
export type AccountStatus = User["accountStatus"];
export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type VerificationToken = typeof verificationTokens.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type ProjectRole = ProjectMember["role"];
export type GlobalRole = User["role"];
export type Project = typeof projects.$inferSelect;
export type Executor = typeof executors.$inferSelect;
export type Flow = typeof flows.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type TaskStage = Task["stage"];
export type Run = typeof runs.$inferSelect;
export type RunStatus = Run["status"];
export type Workspace = typeof workspaces.$inferSelect;
export type HitlRequest = typeof hitlRequests.$inferSelect;
export type StepRun = typeof stepRuns.$inferSelect;
