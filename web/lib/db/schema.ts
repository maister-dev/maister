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
    lastLoginAt: timestamp("last_login_at", {
      withTimezone: true,
      mode: "date",
    }),
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
  repoUrl: text("repo_url"),
  provider: text("provider"),
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

// Immutable, globally content-addressed Flow package revision (M10, ADR-021).
// One row per (flow_ref_id, resolved_revision); the system cache
// ~/.maister/flows/<id>@<sha>/ is shared across projects, so revisions are not
// project-scoped. `package_status` is the GLOBAL revision lifecycle; per-project
// enablement lives on `flows`.
export const flowRevisions = pgTable(
  "flow_revisions",
  {
    id: text("id").primaryKey(),
    flowRefId: text("flow_ref_id").notNull(),
    source: text("source").notNull(),
    versionLabel: text("version_label").notNull(),
    resolvedRevision: text("resolved_revision").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    manifest: jsonb("manifest").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    engineMin: text("engine_min"),
    engineMax: text("engine_max"),
    contract: jsonb("contract"),
    installedPath: text("installed_path").notNull(),
    setupStatus: text("setup_status", {
      enum: ["not_required", "pending", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    packageStatus: text("package_status", {
      enum: ["Discovered", "Installing", "Installed", "Failed", "Removed"],
    })
      .notNull()
      .default("Installing"),
    installedAt: timestamp("installed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRefRevision: unique("flow_revisions_ref_revision_uq").on(
      t.flowRefId,
      t.resolvedRevision,
    ),
  }),
);

// Project-scoped enablement pointer for a Flow id. Keeps the denormalized
// source/version/revision/manifest/... columns as a cache of the CURRENTLY
// ENABLED revision (refreshed on enable/upgrade/rollback); runtime byte
// authority is `flow_revisions` via runs.flow_revision_id.
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
    enabledRevisionId: text("enabled_revision_id").references(
      () => flowRevisions.id,
      { onDelete: "set null" },
    ),
    enablementState: text("enablement_state", {
      enum: [
        "Installed",
        "Enabled",
        "UpdateAvailable",
        "Deprecated",
        "Disabled",
        "Failed",
      ],
    })
      .notNull()
      .default("Installed"),
    trustStatus: text("trust_status", {
      enum: ["untrusted", "trusted", "trusted_by_policy"],
    })
      .notNull()
      .default("untrusted"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
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

export type CapabilityKind =
  | "mcp"
  | "skill"
  | "rule"
  | "setting"
  | "restriction"
  | "tool"
  | "agent_definition"
  | "env_profile";
export type CapabilitySource = "platform" | "project" | "flow-package";
export type CapabilityEnforceability =
  | "enforced"
  | "instructed"
  | "unsupported";
export type CapabilityAgent = "claude" | "codex";
export type CapabilityAgents =
  | CapabilityAgent[]
  | Partial<Record<CapabilityAgent, string>>;

export const capabilityRecords = pgTable(
  "capability_records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    capabilityRefId: text("capability_ref_id").notNull(),
    kind: text("kind", {
      enum: [
        "mcp",
        "skill",
        "rule",
        "setting",
        "restriction",
        "tool",
        "agent_definition",
        "env_profile",
      ],
    }).notNull(),
    label: text("label").notNull(),
    source: text("source", {
      enum: ["platform", "project", "flow-package"],
    }).notNull(),
    version: text("version"),
    revision: text("revision"),
    agents: jsonb("agents").$type<CapabilityAgents>().notNull(),
    enforceability: text("enforceability", {
      enum: ["enforced", "instructed", "unsupported"],
    })
      .notNull()
      .default("instructed"),
    selectedByDefault: boolean("selected_by_default").notNull().default(true),
    selectable: boolean("selectable").notNull().default(true),
    material: jsonb("material")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    disabledAt: timestamp("disabled_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqCapabilityRefPerProject: unique("capability_records_project_ref_uq").on(
      t.projectId,
      t.source,
      t.kind,
      t.capabilityRefId,
    ),
    idxProjectKindSelectable: index("capability_records_project_kind_idx").on(
      t.projectId,
      t.kind,
      t.selectable,
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

export type RunKind = "flow" | "scratch";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    runKind: text("run_kind", { enum: ["flow", "scratch"] })
      .notNull()
      .default("flow"),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowId: text("flow_id").references(() => flows.id, {
      onDelete: "cascade",
    }),
    executorId: text("executor_id")
      .notNull()
      .references(() => executors.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "Pending",
        "Running",
        "NeedsInput",
        "NeedsInputIdle",
        "HumanWorking",
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
    // Pinned immutable package revision (M10, ADR-021). Nullable for
    // pre-migration legacy rows; new runs always set it and the runner reads
    // the manifest + install path from this revision, not from live flows.*.
    flowRevisionId: text("flow_revision_id").references(
      () => flowRevisions.id,
      {
        onDelete: "set null",
      },
    ),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    resumeStartedAt: timestamp("resume_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    // M19 crash-recover (ADR-034): the node id retained when a Running run is
    // crashed (current_step_id is nulled for a clean terminal read). Recover
    // re-dispatches THIS node; null → no resumable target → discard-only.
    resumeTargetStepId: text("resume_target_step_id"),
  },
  (t) => ({
    idxProjectStatus: index("runs_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    idxProjectStatusKind: index("runs_project_status_kind_idx").on(
      t.projectId,
      t.status,
      t.runKind,
    ),
    idxTask: index("runs_task_idx").on(t.taskId),
    idxKindTask: index("runs_kind_task_idx").on(t.runKind, t.taskId),
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
  scheduledRemovalAt: timestamp("scheduled_removal_at", {
    withTimezone: true,
    mode: "date",
  }),
  archivedBranch: text("archived_branch"),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
});

export type ScratchDialogStatus =
  | "Starting"
  | "WaitingForUser"
  | "Running"
  | "NeedsInput"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned";

export type ScratchMessageRole = "user" | "assistant" | "tool" | "system";
export type ScratchAttachmentKind =
  | "issue_url"
  | "file_path"
  | "text_note"
  | "uploaded_file";
export type ScratchPlanMode = "off" | "plan-first";
export type ScratchWorkMode = "auto" | "plan_first" | "manual_approval";
export type ScratchReasoningEffort = "low" | "high" | "extra" | "ultra";
export type ScratchAdapterLaunch = {
  env?: Record<string, string>;
  preArgs?: string[];
  postArgs?: string[];
};

export const scratchRuns = pgTable(
  "scratch_runs",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name"),
    initialPrompt: text("initial_prompt").notNull(),
    workMode: text("work_mode", {
      enum: ["auto", "plan_first", "manual_approval"],
    })
      .notNull()
      .default("auto"),
    reasoningEffort: text("reasoning_effort", {
      enum: ["low", "high", "extra", "ultra"],
    })
      .notNull()
      .default("high"),
    planMode: text("plan_mode", { enum: ["off", "plan-first"] })
      .notNull()
      .default("off"),
    linkedTaskId: text("linked_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    linkedIssueUrl: text("linked_issue_url"),
    baseBranch: text("base_branch").notNull(),
    baseCommit: text("base_commit").notNull(),
    targetBranch: text("target_branch"),
    dialogStatus: text("dialog_status", {
      enum: [
        "Starting",
        "WaitingForUser",
        "Running",
        "NeedsInput",
        "Review",
        "Crashed",
        "Done",
        "Abandoned",
      ],
    })
      .notNull()
      .default("Starting"),
    supervisorSessionId: text("supervisor_session_id"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorMetadata: jsonb("error_metadata").$type<Record<string, unknown>>(),
    lastUserMessageAt: timestamp("last_user_message_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastAgentMessageAt: timestamp("last_agent_message_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProjectStatus: index("scratch_runs_project_status_idx").on(
      t.projectId,
      t.dialogStatus,
    ),
  }),
);

export const scratchMessages = pgTable(
  "scratch_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scratchRuns.runId, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role", {
      enum: ["user", "assistant", "tool", "system"],
    }).notNull(),
    content: text("content").notNull(),
    supervisorEventId: text("supervisor_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRunSequence: unique("scratch_messages_run_sequence_uq").on(
      t.runId,
      t.sequence,
    ),
  }),
);

export const scratchAttachments = pgTable(
  "scratch_attachments",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scratchRuns.runId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => scratchMessages.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", {
      enum: ["issue_url", "file_path", "text_note", "uploaded_file"],
    }).notNull(),
    label: text("label"),
    value: text("value").notNull(),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    storagePath: text("storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxRun: index("scratch_attachments_run_idx").on(t.runId),
    idxMessage: index("scratch_attachments_message_idx").on(t.messageId),
  }),
);

export const scratchCapabilityProfiles = pgTable(
  "scratch_capability_profiles",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .unique()
      .references(() => scratchRuns.runId, { onDelete: "cascade" }),
    profileDigest: text("profile_digest").notNull(),
    materializedPath: text("materialized_path").notNull(),
    selectedMcpIds: jsonb("selected_mcp_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    selectedSkillIds: jsonb("selected_skill_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    selectedRuleIds: jsonb("selected_rule_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    restrictions: jsonb("restrictions")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    adapterLaunch: jsonb("adapter_launch")
      .$type<ScratchAdapterLaunch>()
      .notNull()
      .default({}),
    downgradeNotes: jsonb("downgrade_notes").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
);

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

// --- M11a: Flow graph v1 execution ledger (ADR-027 / ADR-028) -------------

// M11c (ADR-032): one resolved verdict per declared capability class, captured
// in node_attempts.enforcement_snapshot at launch/first-attempt.
export type EnforcementSnapshotEntry = {
  class:
    | "mcps"
    | "tools"
    | "skills"
    | "restrictions"
    | "permissionMode"
    | "workspaceAccess";
  declared: "strict" | "instruct" | "off";
  capability: "enforced" | "instructed" | "unsupported";
  verdict: "enforced" | "instructed" | "refused";
};

// Append-only per-node-attempt ledger written by the graph runner. `attempt`
// auto-increments per (run, node); rework never mutates a prior row. Linear
// `steps[]` flows compile to nodes and write here too; `step_runs` is retained
// for legacy reads (templating highest-attempt-wins union).
export const nodeAttempts = pgTable(
  "node_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    // `guard` is an internal compiled-linear node type (a legacy `guard` step
    // compiles to a guard node); manifest `nodes[]` use the other five. The DB
    // column is plain text (no CHECK), so this enum is TS-level only.
    nodeType: text("node_type", {
      enum: ["ai_coding", "cli", "check", "judge", "human", "guard"],
    }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    // PascalCase node-lifecycle vocabulary: extends step_runs (adds
    // Reworked/Stale, omits Skipped). Distinct from gate_results.status.
    status: text("status", {
      enum: [
        "Pending",
        "Running",
        "Succeeded",
        "Failed",
        "NeedsInput",
        "Reworked",
        "Stale",
      ],
    })
      .notNull()
      .default("Pending"),
    decision: text("decision"),
    workspacePolicy: text("workspace_policy", {
      enum: ["keep", "rewind-to-node-checkpoint", "fresh-attempt"],
    }),
    reworkFromNode: text("rework_from_node"),
    acpSessionId: text("acp_session_id"),
    stdout: text("stdout"),
    vars: jsonb("vars").$type<Record<string, unknown>>().notNull().default({}),
    exitCode: integer("exit_code"),
    errorCode: text("error_code"),
    // M11b (ADR-030): takeover columns — populated ONLY on the human_review
    // node's takeover attempt. `owner_user_id` records the claiming user;
    // `base_ref`/`returned_commits`/`returned_diff` capture the raw
    // `git merge-base`/`git log`/`git diff` text on return. All nullable.
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    baseRef: text("base_ref"),
    returnedCommits: text("returned_commits"),
    returnedDiff: text("returned_diff"),
    // M11c (ADR-032): append-only audit of the resolved per-capability-class
    // enforcement verdicts at launch/first-attempt. Written on BOTH the pass
    // and refusal paths; never a mutable mirror of a YAML field. Nullable for
    // pre-M11c rows and non-capability nodes (cli/check/human).
    enforcementSnapshot: jsonb("enforcement_snapshot").$type<
      EnforcementSnapshotEntry[]
    >(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    uniqRunNodeAttempt: unique("node_attempts_run_node_attempt_uq").on(
      t.runId,
      t.nodeId,
      t.attempt,
    ),
    idxRun: index("node_attempts_run_idx").on(t.runId),
  }),
);

// Structured AI/skill gate verdict (ADR-028). Stored in gate_results.verdict.
export type GateVerdict = {
  verdict: string;
  confidence?: number;
  reasons?: string[];
  recommendedAction?: string;
};

// One row per gate execution. lowercase status (gate-verdict vocabulary,
// distinct from node_attempts.status PascalCase). M11a executes
// command_check/ai_judgment/human_review (+ skill_check best-effort);
// artifact_required -> skipped, external_check -> pending (deferred).
export const gateResults = pgTable(
  "gate_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeAttemptId: text("node_attempt_id")
      .notNull()
      .references(() => nodeAttempts.id, { onDelete: "cascade" }),
    gateId: text("gate_id").notNull(),
    kind: text("kind", {
      enum: [
        "command_check",
        "skill_check",
        "ai_judgment",
        "artifact_required",
        "external_check",
        "human_review",
      ],
    }).notNull(),
    mode: text("mode", { enum: ["blocking", "advisory"] })
      .notNull()
      .default("blocking"),
    status: text("status", {
      enum: [
        "pending",
        "running",
        "passed",
        "failed",
        "stale",
        "skipped",
        "overridden",
      ],
    })
      .notNull()
      .default("pending"),
    verdict: jsonb("verdict").$type<GateVerdict>(),
    inputArtifactRefs: jsonb("input_artifact_refs").$type<string[]>(),
    outputArtifactRef: text("output_artifact_ref"),
    staleFrom: jsonb("stale_from").$type<string[]>(),
    overriddenBy: text("overridden_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxRun: index("gate_results_run_idx").on(t.runId),
    idxNodeAttempt: index("gate_results_node_attempt_idx").on(t.nodeAttemptId),
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
    // M11a (ADR-028): review-decision fields claimed from response.decision for
    // a graph human_review HITL, validated against schema's allow-list.
    decision: text("decision"),
    workspacePolicy: text("workspace_policy"),
    reworkTarget: text("rework_target"),
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
export type FlowRevision = typeof flowRevisions.$inferSelect;
export type FlowEnablementState = Flow["enablementState"];
export type FlowTrustStatus = Flow["trustStatus"];
export type FlowPackageStatus = FlowRevision["packageStatus"];
export type FlowSetupStatus = FlowRevision["setupStatus"];
export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type TaskStage = Task["stage"];
export type Run = typeof runs.$inferSelect;
export type RunStatus = Run["status"];
export type Workspace = typeof workspaces.$inferSelect;
export type ScratchRun = typeof scratchRuns.$inferSelect;
export type ScratchMessage = typeof scratchMessages.$inferSelect;
export type ScratchAttachment = typeof scratchAttachments.$inferSelect;
export type ScratchCapabilityProfile =
  typeof scratchCapabilityProfiles.$inferSelect;
export type HitlRequest = typeof hitlRequests.$inferSelect;
export type StepRun = typeof stepRuns.$inferSelect;
export type NodeAttempt = typeof nodeAttempts.$inferSelect;
export type NodeAttemptStatus = NodeAttempt["status"];
export type NodeAttemptType = NodeAttempt["nodeType"];
export type GateResult = typeof gateResults.$inferSelect;
export type GateResultStatus = GateResult["status"];
export type GateKind = GateResult["kind"];
