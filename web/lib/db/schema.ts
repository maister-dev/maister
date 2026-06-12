import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import { DOMAIN_EVENT_KINDS } from "@/lib/domain-events/taxonomy";

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
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
    updatedBy: text("updated_by"),
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
  defaultRunnerId: text("default_runner_id"),
  promotionMode: text("promotion_mode"),
  taskKey: text("task_key").notNull().unique(),
  nextTaskNumber: integer("next_task_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
});

export type PlatformRunnerProvider =
  | { kind: "anthropic" }
  | { kind: "anthropic_compatible"; baseUrl?: string; authToken?: string }
  | { kind: "openai" }
  | {
      kind: "openai_compatible";
      baseUrl?: string;
      apiKey?: string;
      wireApi?: "responses";
    }
  | { kind: "google_gemini"; apiKey?: string }
  | {
      kind: "google_vertex";
      projectId?: string;
      location?: string;
      apiKey?: string;
    }
  | { kind: "google_gateway"; baseUrl?: string; apiKey?: string }
  | { kind: "agent_native" };

export type RunnerSnapshot = {
  id: string;
  adapter: string;
  capabilityAgent: string;
  model: string;
  provider?: PlatformRunnerProvider;
  providerKind: string;
  permissionPolicy: string;
  sidecar?: {
    id: string;
    kind: "ccr";
    lifecycle?: "managed" | "external";
    configPath?: string | null;
    baseUrl?: string | null;
    healthcheckUrl?: string | null;
    authTokenRef?: string | null;
  } | null;
  sidecarId?: string | null;
};

export const platformRouterSidecars = pgTable("platform_router_sidecars", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["ccr"] }).notNull(),
  lifecycle: text("lifecycle", { enum: ["managed", "external"] }).notNull(),
  commandPreset: text("command_preset", { enum: ["ccr_start"] }),
  configPath: text("config_path"),
  baseUrl: text("base_url"),
  healthcheckUrl: text("healthcheck_url"),
  authTokenRef: text("auth_token_ref"),
  readinessStatus: text("readiness_status", {
    enum: ["Unknown", "Ready", "NotReady"],
  })
    .notNull()
    .default("Unknown"),
  readinessReasons: jsonb("readiness_reasons")
    .$type<string[]>()
    .notNull()
    .default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const platformAcpRunners = pgTable(
  "platform_acp_runners",
  {
    id: text("id").primaryKey(),
    adapter: text("adapter", { enum: ADAPTER_IDS }).notNull(),
    capabilityAgent: text("capability_agent", {
      enum: ADAPTER_IDS,
    }).notNull(),
    model: text("model").notNull(),
    provider: jsonb("provider").$type<PlatformRunnerProvider>().notNull(),
    permissionPolicy: text("permission_policy", {
      enum: ["default", "dangerously_skip_permissions"],
    })
      .notNull()
      .default("default"),
    sidecarId: text("sidecar_id").references(() => platformRouterSidecars.id, {
      onDelete: "set null",
    }),
    readinessStatus: text("readiness_status", {
      enum: ["Unknown", "Ready", "NotReady"],
    })
      .notNull()
      .default("Unknown"),
    readinessReasons: jsonb("readiness_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxAdapterEnabled: index("platform_acp_runners_adapter_enabled_idx").on(
      t.adapter,
      t.enabled,
    ),
    idxSidecar: index("platform_acp_runners_sidecar_idx").on(t.sidecarId),
  }),
);

export const platformRuntimeSettings = pgTable("platform_runtime_settings", {
  id: text("id").primaryKey().default("singleton"),
  defaultRunnerId: text("default_runner_id")
    .notNull()
    .references(() => platformAcpRunners.id),
  webhooksEnabled: boolean("webhooks_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// Platform-scoped MCP capability catalog (M27/T-C2, ADR-067). Admin CRUD mirrors
// platform_acp_runners (ADR-065). Secrets are NEVER stored: env_keys/header_keys
// are `env:NAME` references resolved supervisor-side, never plaintext values.
export const platformMcpServers = pgTable(
  "platform_mcp_servers",
  {
    id: text("id").primaryKey(),
    transport: text("transport", { enum: ["stdio", "sse", "http"] })
      .notNull()
      .default("stdio"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    envKeys: jsonb("env_keys").$type<string[]>().notNull().default([]),
    url: text("url"),
    headerKeys: jsonb("header_keys").$type<string[]>().notNull().default([]),
    supportedAgents: jsonb("supported_agents")
      .$type<AdapterId[]>()
      .notNull()
      .default([...ADAPTER_IDS]),
    trustStatus: text("trust_status", {
      enum: ["untrusted", "trusted", "trusted_by_policy"],
    })
      .notNull()
      .default("untrusted"),
    readinessStatus: text("readiness_status", {
      enum: ["Unknown", "Ready", "NotReady"],
    })
      .notNull()
      .default("Unknown"),
    readinessReasons: jsonb("readiness_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxTransportEnabled: index("platform_mcp_servers_transport_enabled_idx").on(
      t.transport,
      t.enabled,
    ),
  }),
);
export type PlatformMcpServer = typeof platformMcpServers.$inferSelect;

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
    defaultRunnerId: text("default_runner_id").references(
      () => platformAcpRunners.id,
      { onDelete: "set null" },
    ),
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
    // Two-axis trust (§4.2): exec_trust gates setup.sh and MCP stdio spawn.
    // Default 'untrusted'; flipped to 'trusted' via POST trust-executable (T-B3).
    execTrust: text("exec_trust", { enum: ["untrusted", "trusted"] })
      .notNull()
      .default("untrusted"),
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
    versionBinding: text("version_binding", { enum: ["pinned", "latest"] })
      .notNull()
      .default("latest"),
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

// M22 flow-graph layout: authored node positions live in the flow.yaml
// `presentation` section (ADR-064), NOT a DB store. The dropped
// `flow_graph_layouts` table (migration 0024) is reverted in migration 0030.

// M13 (ADR-040): Flow roles are project-scoped routing labels, not RBAC.
// Authorization still comes from project_members.role through authz.ts.
export const projectFlowRoles = pgTable(
  "project_flow_roles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roleRef: text("role_ref").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    source: text("source", { enum: ["config", "flow", "system"] })
      .notNull()
      .default("config"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectRole: unique("project_flow_roles_project_key_uq").on(
      t.projectId,
      t.roleRef,
    ),
    idxProject: index("project_flow_roles_project_idx").on(t.projectId),
  }),
);

// M13 (ADR-040): actor attribution. M13 web writes resolve only kind="user";
// api_token/internal_agent/system are schema-supported for future attribution.
export const actorIdentities = pgTable(
  "actor_identities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["user", "api_token", "internal_agent", "system"],
    }).notNull(),
    label: text("label").notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    tokenId: text("token_id"),
    internalAgentRef: text("internal_agent_ref"),
    systemKey: text("system_key"),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectUserActor: uniqueIndex("actor_identities_project_user_uq")
      .on(t.projectId, t.userId)
      .where(sql`${t.kind} = 'user'`),
    // M17 (0026): a project's api_token actor is unique per (project, token) so
    // ensureApiTokenActor upserts. Partial — user/system rows (NULL token_id)
    // stay distinct and unaffected.
    uniqProjectTokenActor: uniqueIndex("actor_identities_project_token_uq")
      .on(t.projectId, t.tokenId)
      .where(sql`${t.kind} = 'api_token'`),
    idxProject: index("actor_identities_project_idx").on(t.projectId),
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
export type CapabilityAgent = AdapterId;
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

export type SchedulerJobKind =
  | "system_sweep"
  | "command"
  | "agent_tick"
  | "flow_run"
  | "run_schedule"
  | "webhook_delivery"
  | "domain_event_dispatch";
export type SchedulerJobRunStatus =
  | "Claimed"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Skipped";

export const schedulerJobs = pgTable(
  "scheduler_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    jobKind: text("job_kind", {
      enum: [
        "system_sweep",
        "command",
        "agent_tick",
        "flow_run",
        "run_schedule",
        "webhook_delivery",
        "domain_event_dispatch",
      ],
    }).notNull(),
    target: jsonb("target")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    cadenceIntervalSeconds: integer("cadence_interval_seconds").notNull(),
    nextRunAt: timestamp("next_run_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastFiredAt: timestamp("last_fired_at", {
      withTimezone: true,
      mode: "date",
    }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    maxFailures: integer("max_failures").notNull().default(3),
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
    idxDue: index("scheduler_jobs_due_idx").on(t.disabledAt, t.nextRunAt),
    idxKindDue: index("scheduler_jobs_kind_due_idx").on(t.jobKind, t.nextRunAt),
    idxProjectKind: index("scheduler_jobs_project_kind_idx").on(
      t.projectId,
      t.jobKind,
    ),
  }),
);

export const schedulerJobRuns = pgTable(
  "scheduler_job_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => schedulerJobs.id, { onDelete: "cascade" }),
    jobKind: text("job_kind", {
      enum: [
        "system_sweep",
        "command",
        "agent_tick",
        "flow_run",
        "run_schedule",
        "webhook_delivery",
        "domain_event_dispatch",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["Claimed", "Running", "Succeeded", "Failed", "Skipped"],
    })
      .notNull()
      .default("Claimed"),
    claimedAt: timestamp("claimed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "date",
    }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxJob: index("scheduler_job_runs_job_idx").on(t.jobId),
    idxLease: index("scheduler_job_runs_lease_idx").on(
      t.status,
      t.leaseExpiresAt,
    ),
  }),
);

export type AgentScope = "platform" | "project";
export type AgentWorkspace = "none" | "repo_read" | "worktree";
export type AgentMode = "session" | "subagent";
export type AgentRiskTier = "read_only" | "standard" | "destructive";
export type AgentTriggerKind =
  | "manual"
  | "cron"
  | "domain_event"
  | "webhook"
  | "flow";

export const agents = pgTable(
  "agents",
  {
    // The catalog dir name under ~/.maister/agents/ (SAFE_PATH_SEGMENT).
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["platform", "project"] }).notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    workspace: text("workspace", {
      enum: ["none", "repo_read", "worktree"],
    }).notNull(),
    mode: text("mode", { enum: ["session", "subagent"] }).notNull(),
    triggers: jsonb("triggers").$type<AgentTriggerKind[]>().notNull(),
    capabilityProfile:
      jsonb("capability_profile").$type<Record<string, unknown>>(),
    riskTier: text("risk_tier", {
      enum: ["read_only", "standard", "destructive"],
    }).notNull(),
    sourcePath: text("source_path").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    quarantinedAt: timestamp("quarantined_at", {
      withTimezone: true,
      mode: "date",
    }),
    quarantineReason: text("quarantine_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProject: index("agents_project_idx").on(t.projectId),
    scopeProjectCheck: check(
      "agents_scope_project_check",
      sql`(${t.scope} = 'project') = (${t.projectId} IS NOT NULL)`,
    ),
  }),
);

export const agentProjectLinks = pgTable(
  "agent_project_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    runnerOverrideId: text("runner_override_id").references(
      () => platformAcpRunners.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAgentProject: unique("agent_project_links_agent_project_uq").on(
      t.agentId,
      t.projectId,
    ),
    idxProject: index("agent_project_links_project_idx").on(t.projectId),
  }),
);

// M33 (ADR-087) rework of the dead M24 shape: real agents FK (was text
// agent_ref), cron fields claimed atomically by the agent_tick.dispatcher,
// event rows consumed by the agent_triggers outbox consumer. The M24
// scheduler_job_id bridge and desired_state ('continuous' = future Mγ) are
// dropped.
export const agentSchedules = pgTable(
  "agent_schedules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type", {
      enum: ["cron", "event"],
    }).notNull(),
    cronExpr: text("cron_expr"),
    timezone: text("timezone"),
    nextFireAt: timestamp("next_fire_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastFiredAt: timestamp("last_fired_at", {
      withTimezone: true,
      mode: "date",
    }),
    eventMatch: jsonb("event_match").$type<{ kinds: string[] }>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProjectAgent: index("agent_schedules_project_agent_idx").on(
      t.projectId,
      t.agentId,
    ),
    idxDueCron: index("agent_schedules_due_cron_idx").on(
      t.triggerType,
      t.enabled,
      t.nextFireAt,
    ),
    cronShapeCheck: check(
      "agent_schedules_cron_shape_check",
      sql`(${t.triggerType} <> 'cron') OR (${t.cronExpr} IS NOT NULL AND ${t.timezone} IS NOT NULL AND ${t.nextFireAt} IS NOT NULL)`,
    ),
    eventShapeCheck: check(
      "agent_schedules_event_shape_check",
      sql`(${t.triggerType} <> 'event') OR (${t.eventMatch} IS NOT NULL)`,
    ),
  }),
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type AgentProjectLinkRow = typeof agentProjectLinks.$inferSelect;
export type AgentScheduleRow = typeof agentSchedules.$inferSelect;

export type AuthoredCapabilityKind = "rule" | "skill" | "flow";
export type AuthoredCapabilityLifecycle = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export const authoredCapabilities = pgTable(
  "authored_capabilities",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["rule", "skill", "flow"] }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    lifecycle: text("lifecycle", {
      enum: ["DRAFT", "PUBLISHED", "ARCHIVED"],
    })
      .notNull()
      .default("DRAFT"),
    draftVersion: integer("draft_version").notNull().default(1),
    currentDraftRevisionId: text("current_draft_revision_id"),
    currentPublishedRevisionId: text("current_published_revision_id"),
    sourceFlowRefId: text("source_flow_ref_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectKindSlug: unique(
      "authored_capabilities_project_kind_slug_uq",
    ).on(t.projectId, t.kind, t.slug),
    idxProjectKind: index("authored_capabilities_project_kind_idx").on(
      t.projectId,
      t.kind,
    ),
  }),
);

export const authoredCapabilityRevisions = pgTable(
  "authored_capability_revisions",
  {
    id: text("id").primaryKey(),
    capabilityId: text("capability_id")
      .notNull()
      .references(() => authoredCapabilities.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["rule", "skill", "flow"] }).notNull(),
    revisionNumber: integer("revision_number").notNull(),
    lifecycle: text("lifecycle", {
      enum: ["DRAFT", "PUBLISHED", "ARCHIVED"],
    })
      .notNull()
      .default("DRAFT"),
    draftVersion: integer("draft_version").notNull(),
    title: text("title").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
    manifest: jsonb("manifest").$type<Record<string, unknown> | null>(),
    schemaVersion: integer("schema_version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    uniqCapabilityRevision: unique(
      "authored_capability_revisions_capability_revision_uq",
    ).on(t.capabilityId, t.revisionNumber),
    uniqActiveDraft: uniqueIndex(
      "authored_capability_revisions_active_draft_uq",
    )
      .on(t.capabilityId)
      .where(sql`${t.lifecycle} = 'DRAFT'`),
    idxCapabilityLifecycle: index(
      "authored_capability_revisions_capability_lifecycle_idx",
    ).on(t.capabilityId, t.lifecycle),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    // M33 (ADR-087): NULLABLE — simple-intent tasks are created flowless and
    // classify `unconfigured` until a triage verdict or the launch popover
    // fills the flow.
    flowId: text("flow_id").references(() => flows.id),
    status: text("status", {
      enum: ["Backlog", "InFlight", "Done", "Abandoned"],
    })
      .notNull()
      .default("Backlog"),
    stage: text("stage", { enum: ["Backlog", "Prepare"] })
      .notNull()
      .default("Backlog"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    // M33 (ADR-087) launch-verdict columns: written by the ext triage op /
    // the card popover PATCH; runner rides the launchOverride tier at launch.
    triageStatus: text("triage_status", { enum: ["triaged"] }),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    targetBranch: text("target_branch"),
    promotionMode: text("promotion_mode", {
      enum: ["local_merge", "pull_request"],
    }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAttempt: unique("tasks_id_attempt_uq").on(t.id, t.attemptNumber),
    uniqProjectNumber: unique("tasks_project_number_uq").on(
      t.projectId,
      t.number,
    ),
    idxProjectStatus: index("tasks_project_status_idx").on(
      t.projectId,
      t.status,
    ),
  }),
);

export const projectFlowRunnerDefaults = pgTable(
  "project_flow_runner_defaults",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectFlow: unique("project_flow_runner_defaults_project_flow_uq").on(
      t.projectId,
      t.flowId,
    ),
  }),
);

export const flowRunnerRemaps = pgTable(
  "flow_runner_remaps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    flowRevisionId: text("flow_revision_id")
      .notNull()
      .references(() => flowRevisions.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    sourceRunnerId: text("source_runner_id").notNull(),
    mappedRunnerId: text("mapped_runner_id").references(
      () => platformAcpRunners.id,
      { onDelete: "set null" },
    ),
    status: text("status", { enum: ["Pending", "Mapped"] })
      .notNull()
      .default("Pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectRevisionStepSource: unique(
      "flow_runner_remaps_project_revision_step_source_uq",
    ).on(t.projectId, t.flowRevisionId, t.stepId, t.sourceRunnerId),
    idxMappedRunner: index("flow_runner_remaps_mapped_runner_idx").on(
      t.mappedRunnerId,
    ),
  }),
);

export type RunKind = "flow" | "scratch" | "agent";

// M27/T-C8 (§3.1, ADR-069): the capability set resolved at launch, frozen onto
// the run so an edit/publish mid-run cannot mutate it. `flowOrigin` records
// whether the resolved flow revision came from the authored bridge or git.
export type ResolvedCapabilitySet = {
  flowRevisionId: string;
  flowOrigin: "authored" | "git";
  // `scope` is the winning record's source (project | platform | flow-package);
  // the runner pins its materialization universe to (kind, refId, scope) so a
  // mid-run record added at another scope cannot override the frozen winner
  // (M27/T-B5 in-flight immutability).
  capabilities: Array<{
    refId: string;
    kind: string;
    sha: string | null;
    scope: string;
  }>;
  mcps: Array<{ refId: string; sha: string | null; scope: string }>;
};

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    runKind: text("run_kind", { enum: ["flow", "scratch", "agent"] })
      .notNull()
      .default("flow"),
    // M33 (ADR-087): set iff runKind='agent'. SET NULL so run history
    // survives catalog deletes (deletes are usage-guarded for live runs).
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    triggerSource: text("trigger_source", {
      enum: ["manual", "cron", "domain_event", "webhook", "flow"],
    }),
    // domain_events.id claim key — partial UNIQUE (agent_id, trigger_event_id)
    // makes at-least-once redelivery converge to exactly one run.
    triggerEventId: bigint("trigger_event_id", { mode: "number" }),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowId: text("flow_id").references(() => flows.id, {
      onDelete: "cascade",
    }),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    runnerResolutionTier: text("runner_resolution_tier", {
      enum: [
        "launchOverride",
        "stepTarget",
        "projectFlowDefault",
        "platformFlowDefault",
        "projectDefault",
        "platformDefault",
        // M33 (ADR-087) standalone agent chain tiers.
        "agentLinkOverride",
        "agentDefault",
      ],
    }),
    capabilityAgent: text("capability_agent", {
      enum: ADAPTER_IDS,
    }),
    runnerSnapshot: jsonb("runner_snapshot").$type<RunnerSnapshot>(),
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
    // M27/T-C8: capability set resolved + frozen at launch (read by the runner
    // for in-flight immutability). Nullable for pre-migration / legacy runs.
    resolvedCapabilitySet: jsonb(
      "resolved_capability_set",
    ).$type<ResolvedCapabilitySet>(),
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
    idxRunner: index("runs_runner_idx").on(t.runnerId),
    // M33 (ADR-087): outbox→spawn no-dup claim under at-least-once redelivery.
    uniqAgentTriggerEvent: uniqueIndex("runs_agent_trigger_event_uq")
      .on(t.agentId, t.triggerEventId)
      .where(sql`${t.triggerEventId} IS NOT NULL`),
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
  baseBranch: text("base_branch"),
  baseCommit: text("base_commit"),
  targetBranch: text("target_branch"),
  promotionMode: text("promotion_mode"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  promotedAt: timestamp("promoted_at", { withTimezone: true, mode: "date" }),
  promotionState: text("promotion_state").notNull().default("none"),
  promotionClaimedAt: timestamp("promotion_claimed_at", {
    withTimezone: true,
    mode: "date",
  }),
  promotionOwnerUserId: text("promotion_owner_user_id").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  promotionAttemptId: text("promotion_attempt_id"),
  lifecycleOperationState: text("lifecycle_operation_state")
    .notNull()
    .default("none"),
  lifecycleOperationClaimedAt: timestamp("lifecycle_operation_claimed_at", {
    withTimezone: true,
    mode: "date",
  }),
  lifecycleOperationAttemptId: text("lifecycle_operation_attempt_id"),
  lifecycleOperationName: text("lifecycle_operation_name"),
});

export type RunScheduleOverlapPolicy = "skip" | "queue_one" | "start_anyway";
export type RunScheduleFireOutcome =
  | "launched"
  | "queued_pending"
  | "catchup_queued"
  | "skipped_task_busy"
  | "skipped_cap"
  | "skipped_target_terminal"
  | "skipped_crashed"
  | "skipped_blocked"
  | "launch_failed"
  | "dispatching";

export const runSchedules = pgTable(
  "run_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone").notNull(),
    overlapPolicy: text("overlap_policy", {
      enum: ["skip", "queue_one", "start_anyway"],
    })
      .notNull()
      .default("skip"),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    nextFireAt: timestamp("next_fire_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    queueOnePending: boolean("queue_one_pending").notNull().default(false),
    queuedFireAt: timestamp("queued_fire_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastFiredAt: timestamp("last_fired_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastFireOutcome: text("last_fire_outcome", {
      enum: [
        "launched",
        "queued_pending",
        "catchup_queued",
        "skipped_task_busy",
        "skipped_cap",
        "skipped_target_terminal",
        "skipped_crashed",
        "skipped_blocked",
        "launch_failed",
        "dispatching",
      ],
    }),
    lastFireError: text("last_fire_error"),
    lastRunId: text("last_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProject: index("run_schedules_project_idx").on(t.projectId),
    idxTask: index("run_schedules_task_idx").on(t.taskId),
    idxDue: index("run_schedules_due_idx").on(t.enabled, t.nextFireAt),
    idxLastRun: index("run_schedules_last_run_idx").on(t.lastRunId),
  }),
);

export type RunSchedule = typeof runSchedules.$inferSelect;

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
      enum: ["ai_coding", "cli", "check", "judge", "human", "guard", "form"],
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
    // M30 (ADR-079): namespaced dangling checkpoint ref
    // (refs/maister/checkpoints/<runId>/<nodeAttemptId>) captured before the
    // attempt; rewind target is `<ref>^`. Nullable for pre-M30 rows and node
    // types without workspace capture.
    checkpointRef: text("checkpoint_ref"),
    // M30 (ADR-081): effective session policy snapshot for this attempt
    // (rework-transition > node > flow defaults > engine default `resume`).
    // The DB column is plain text (no CHECK), so this enum is TS-level only.
    sessionPolicy: text("session_policy", {
      enum: ["resume", "new_session"],
    }),
    // M30 (ADR-081): true when `resume` was requested but the prior session
    // was gone/unresumable and the engine fell back to a new session.
    sessionFallback: boolean("session_fallback").notNull().default(false),
    // M30 (ADR-080): true when this attempt was auto-scheduled by
    // retry_policy after a retryable failure (vs user/rework initiated).
    autoRetry: boolean("auto_retry").notNull().default(false),
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
    // M14 (ADR-041): scoped capability materialization plan written by the
    // launch pipeline before ACP session spawn. Null for pre-M14 rows and
    // node types that do not trigger capability materialization (cli/check).
    materializationPlan: jsonb(
      "materialization_plan",
    ).$type<MaterializationPlan | null>(),
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
// M16: external_check reports carry CI metadata in the same jsonb (no migration).
export type GateVerdict = {
  verdict?: string;
  confidence?: number;
  reasons?: string[];
  recommendedAction?: string;
  calibration?: {
    confidenceMin: number;
    rawVerdict: string;
    outcome:
      | "above_threshold"
      | "below_threshold"
      | "no_confidence"
      | "missing_confidence_allowed"
      | "invalid_confidence";
  };
  // M16 §B: external_check report metadata.
  externalRunUrl?: string;
  commitSha?: string;
  reporterTokenId?: string;
  reportedAt?: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
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

// M12: typed artifact locator discriminated union (ADR-037).
// Server-written only; payload route re-confines file paths to the run dir.
export type ArtifactLocator =
  | { kind: "git-range"; baseCommit: string; headRef: string }
  | { kind: "git-log"; baseRef: string; headRef: string }
  | { kind: "file"; path: string }
  | { kind: "gate-verdict"; gateResultId: string }
  | { kind: "hitl-response"; hitlRequestId: string }
  | {
      kind: "inline";
      text: string;
      // ADR-072 (additive, OpenAPI ArtifactLocatorInline): set on the
      // composed-rework-payload evidence row (kind human_note, producer
      // runner) — the authoring review-gate hitl_requests id and the open
      // root comment ids serialized into `text` at compose time.
      hitlRequestId?: string;
      threadIds?: string[];
    };

// M12 (ADR-037): queryable evidence index. Payloads live on disk/git.
// Two write paths: runner-inline (majority) and ADR-022 projector (event-stream).
// Validity FSM: current → superseded (new attempt) / stale (rework) / failed / skipped.
// Deterministic PK for idempotent upsert on replay.
export const artifactInstances = pgTable(
  "artifact_instances",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // NULL for task-input / run-level artifacts
    nodeAttemptId: text("node_attempt_id").references(() => nodeAttempts.id, {
      onDelete: "cascade",
    }),
    // Denormalized for grouping/query without joining node_attempts
    nodeId: text("node_id"),
    attempt: integer("attempt"),
    // manifest output.produces[].id; NULL for defaults / projector-derived
    artifactDefId: text("artifact_def_id"),
    kind: text("kind", {
      enum: [
        "diff",
        "log",
        "test_report",
        "lint_report",
        "ai_judgment",
        "human_note",
        "commit_set",
        "checkpoint",
        "preview",
        "generic_file",
        "mutation_report",
      ],
    }).notNull(),
    producer: text("producer", {
      enum: ["runner", "projector", "takeover", "gate", "human"],
    }).notNull(),
    locator: jsonb("locator").$type<ArtifactLocator>().notNull(),
    uri: text("uri"),
    hash: text("hash"),
    sizeBytes: integer("size_bytes"),
    validity: text("validity", {
      enum: ["current", "stale", "superseded", "failed", "skipped"],
    })
      .notNull()
      .default("current"),
    // Snapshot of manifest requiredFor at record time
    requiredFor: jsonb("required_for").$type<("review" | "merge")[]>(),
    visibility: text("visibility", { enum: ["internal", "shared"] })
      .notNull()
      .default("internal"),
    retention: text("retention", { enum: ["run", "ephemeral"] })
      .notNull()
      .default("run"),
    // Supervisor event id for projector rows; NULL for inline runner-recorded
    monotonicId: integer("monotonic_id"),
    // ON DELETE SET NULL — keeps the audit row but clears the forward pointer
    supersededById: text("superseded_by_id").references(
      (): ReturnType<typeof text> => artifactInstances.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxRun: index("artifact_instances_run_idx").on(t.runId),
    idxNodeAttempt: index("artifact_instances_node_attempt_idx").on(
      t.nodeAttemptId,
    ),
    idxRunKind: index("artifact_instances_run_kind_idx").on(t.runId, t.kind),
    idxRunValidity: index("artifact_instances_run_validity_idx").on(
      t.runId,
      t.validity,
    ),
  }),
);

// M12 (ADR-022/ADR-038): per-run projector resume cursor. The projector
// advances this in the same transaction as its upserts (crash-safe replay).
export const artifactProjectionCursors = pgTable(
  "artifact_projection_cursors",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // Events-log scope (per Phase-0 freeze correction: "run" scope, cursor PK = runId)
    scope: text("scope").notNull(),
    eventsLogPath: text("events_log_path").notNull(),
    lastMonotonicId: integer("last_monotonic_id").notNull().default(0),
    status: text("status", {
      enum: ["idle", "running", "caught_up", "failed"],
    })
      .notNull()
      .default("idle"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRunScope: unique("artifact_projection_cursors_run_scope_uq").on(
      t.runId,
      t.scope,
    ),
  }),
);

export const assignments = pgTable(
  "assignments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    nodeId: text("node_id"),
    stepId: text("step_id"),
    hitlRequestId: text("hitl_request_id").references(() => hitlRequests.id, {
      onDelete: "cascade",
    }),
    nodeAttemptId: text("node_attempt_id").references(() => nodeAttempts.id, {
      onDelete: "cascade",
    }),
    actionKind: text("action_kind", {
      enum: [
        "permission",
        "form",
        "human_review",
        "manual_takeover",
        "merge_conflict",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["open", "claimed", "completed", "cancelled"],
    })
      .notNull()
      .default("open"),
    roleRefs: jsonb("role_refs").$type<string[]>().notNull().default([]),
    title: text("title").notNull(),
    assigneeActorId: text("assignee_actor_id").references(
      () => actorIdentities.id,
      { onDelete: "set null" },
    ),
    createdByActorId: text("created_by_actor_id").references(
      () => actorIdentities.id,
      { onDelete: "set null" },
    ),
    completedByActorId: text("completed_by_actor_id").references(
      () => actorIdentities.id,
      { onDelete: "set null" },
    ),
    evidenceArtifactId: text("evidence_artifact_id").references(
      () => artifactInstances.id,
      { onDelete: "set null" },
    ),
    branch: text("branch"),
    ref: text("ref"),
    slaHours: integer("sla_hours"),
    staleEvidenceSummary: jsonb("stale_evidence_summary").$type<
      Record<string, unknown>
    >(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
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
    uniqHitlRequest: unique("assignments_hitl_request_uq").on(t.hitlRequestId),
    idxProjectStatus: index("assignments_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    idxRunStatus: index("assignments_run_status_idx").on(t.runId, t.status),
    idxCurrentActor: index("assignments_current_actor_idx").on(
      t.assigneeActorId,
    ),
    idxHitl: index("assignments_hitl_request_idx").on(t.hitlRequestId),
  }),
);

export const assignmentEvents = pgTable(
  "assignment_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    eventKind: text("event_kind", {
      enum: [
        "created",
        "claimed",
        "released",
        "taken_over",
        "responded",
        "returned",
        "completed",
        "cancelled",
        "superseded",
        "system_closed",
      ],
    }).notNull(),
    actorId: text("actor_id").references(() => actorIdentities.id, {
      onDelete: "set null",
    }),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxAssignment: index("assignment_events_assignment_idx").on(t.assignmentId),
    idxProjectCreated: index("assignment_events_project_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
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
    // M30 (ADR-082): run-branch tip SHA stamped when this review-gate visit
    // opens — the base for the `since-last-review` diff scope. Nullable for
    // non-review HITLs and pre-M30 rows.
    reviewTipSha: text("review_tip_sha"),
    // M30 (ADR-082): the reviewer's explicit dirty-worktree resolution for
    // this review visit. TS-level enum (no CHECK), validated by allow-list
    // at the route boundary.
    dirtyResolution: text("dirty_resolution", {
      enum: ["commit", "discard", "proceed"],
    }),
    // M17 ADR-054: flow-author-declared criticality; write-once at INSERT.
    criticality: text("criticality", {
      enum: ["low", "medium", "high", "critical"],
    }),
    // M17 ADR-054: responder self-reported confidence in [0,1]; set at response time.
    humanConfidence: real("human_confidence"),
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

// ADR-072 (migration 0039): PR-grade, line-anchored, 1-level-threaded review
// comments drafted at an open review gate. A root (parent_id NULL) carries the
// anchor + status; a reply carries neither — enforced by the anchor CHECK
// below. file_path is opaque anchor data, NEVER a filesystem path component.
export const reviewComments = pgTable(
  "review_comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // The review-gate visit (pending hitl_requests row) of authoring.
    hitlRequestId: text("hitl_request_id")
      .notNull()
      .references(() => hitlRequests.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    // 1-based gate visit number — iteration tag for re-review carry.
    gateAttempt: integer("gate_attempt").notNull(),
    parentId: text("parent_id").references(
      (): ReturnType<typeof text> => reviewComments.id,
      { onDelete: "cascade" },
    ),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot — keeps the thread attributable after author deletion.
    authorLabel: text("author_label").notNull(),
    filePath: text("file_path"),
    side: text("side", { enum: ["old", "new"] }),
    line: integer("line"),
    // Server-extracted at POST time; the client value is never trusted.
    lineContent: text("line_content"),
    body: text("body").notNull(),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxRunCreated: index("review_comments_run_created_idx").on(
      t.runId,
      t.createdAt,
    ),
    idxRunStatus: index("review_comments_run_status_idx").on(t.runId, t.status),
    idxHitlRequest: index("review_comments_hitl_request_idx").on(
      t.hitlRequestId,
    ),
    idxParent: index("review_comments_parent_idx").on(t.parentId),
    // Anchor fields non-null ⇔ root row (parent_id NULL).
    anchorRootCheck: check(
      "review_comments_anchor_root_check",
      sql`(${t.parentId} is null and ${t.filePath} is not null and ${t.side} is not null and ${t.line} is not null and ${t.lineContent} is not null) or (${t.parentId} is not null and ${t.filePath} is null and ${t.side} is null and ${t.line} is null and ${t.lineContent} is null)`,
    ),
    sideCheck: check(
      "review_comments_side_check",
      sql`${t.side} in ('old', 'new')`,
    ),
    statusCheck: check(
      "review_comments_status_check",
      sql`${t.status} in ('open', 'resolved')`,
    ),
  }),
);

// M30 (ADR-078, migration 0041): answer-only gate-chat transcript at a
// `human`/`form` HITL pause. Sibling of review_comments by design (DD1):
// review_comments' anchor CHECK requires file/line and has no agent author
// role, so chat rows live here. Chat NEVER resolves the HITL and never
// drives status -> Running; `mutation_reverted` flags turns where the L3
// neutrality sensor restored the workspace (ADR-078/DD11).
export const gateChatMessages = pgTable(
  "gate_chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    hitlRequestId: text("hitl_request_id")
      .notNull()
      .references(() => hitlRequests.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    // 1-based gate visit number — mirrors review_comments.gate_attempt.
    gateAttempt: integer("gate_attempt").notNull(),
    role: text("role", { enum: ["user", "agent"] }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot — keeps the transcript attributable after author deletion.
    authorLabel: text("author_label").notNull(),
    body: text("body").notNull(),
    acpSessionId: text("acp_session_id"),
    // Monotonic per hitl_request_id — transcript ordering. The
    // UNIQUE(hitl_request_id, seq) below makes a concurrent live-path
    // double-submit a catchable 23505 (-> CONFLICT) instead of a
    // silent duplicate-seq insert + double-prompt.
    seq: integer("seq").notNull(),
    mutationReverted: boolean("mutation_reverted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxRun: index("gate_chat_messages_run_idx").on(t.runId),
    idxHitlRequest: index("gate_chat_messages_hitl_request_idx").on(
      t.hitlRequestId,
    ),
    roleCheck: check(
      "gate_chat_messages_role_check",
      sql`${t.role} in ('user', 'agent')`,
    ),
    // Serializes concurrent turns at one HITL pause: the second racing insert
    // hits this constraint (23505) and is surfaced as CONFLICT, not a dup row.
    uniqHitlSeq: unique("gate_chat_messages_hitl_seq_unique").on(
      t.hitlRequestId,
      t.seq,
    ),
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
    addedBy: text("added_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
    updatedBy: text("updated_by"),
  },
  (t) => ({
    uniqMembership: unique("project_members_project_user_uq").on(
      t.projectId,
      t.userId,
    ),
    idxUser: index("project_members_user_idx").on(t.userId),
  }),
);

// --- M14 (ADR-041): scoped capability materialization -------------------------------------

// Written by the launch pipeline; records what was resolved and applied for an
// ai_coding / judge node attempt. Stored in node_attempts.materialization_plan.
export type MaterializationPlan = {
  profileDigest: string;
  resolvedRevisions: { refId: string; kind: string; sha: string }[];
  materializedFiles: string[];
  enforcedClasses: string[];
  instructedClasses: string[];
  refusedClasses: string[];
  cleanup: {
    status: "pending" | "done" | "failed";
    error?: string;
    at?: string;
  };
};

// Immutable per-(project, capabilityRefId, resolvedRevision) capability bundle record.
// Mirrors flowRevisions in structure: one row per resolved git revision,
// globally content-addressed, project-scoped (capabilities live per project).
export const capabilityImports = pgTable(
  "capability_imports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    capabilityRefId: text("capability_ref_id").notNull(),
    source: text("source").notNull(),
    versionTag: text("version_tag").notNull(),
    resolvedRevision: text("resolved_revision").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    manifest: jsonb("manifest").notNull(),
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
    uniqProjectRefRevision: unique(
      "capability_imports_project_ref_revision_uq",
    ).on(t.projectId, t.capabilityRefId, t.resolvedRevision),
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
export type PlatformAcpRunner = typeof platformAcpRunners.$inferSelect;
export type PlatformRouterSidecar = typeof platformRouterSidecars.$inferSelect;
export type PlatformRuntimeSettings =
  typeof platformRuntimeSettings.$inferSelect;
export type ProjectFlowRunnerDefault =
  typeof projectFlowRunnerDefaults.$inferSelect;
export type FlowRunnerRemap = typeof flowRunnerRemaps.$inferSelect;
export type Flow = typeof flows.$inferSelect;
export type FlowRevision = typeof flowRevisions.$inferSelect;
export type FlowEnablementState = Flow["enablementState"];
export type FlowTrustStatus = Flow["trustStatus"];
export type FlowPackageStatus = FlowRevision["packageStatus"];
export type FlowSetupStatus = FlowRevision["setupStatus"];
export type FlowRevisionExecTrust = FlowRevision["execTrust"];
export type ProjectFlowRole = typeof projectFlowRoles.$inferSelect;
export type ActorIdentity = typeof actorIdentities.$inferSelect;
export type ActorIdentityKind = ActorIdentity["kind"];
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
export type ArtifactInstance = typeof artifactInstances.$inferSelect;
export type ArtifactInstanceInsert = typeof artifactInstances.$inferInsert;
export type ArtifactValidity = ArtifactInstance["validity"];
export type ArtifactKind = ArtifactInstance["kind"];
export type ArtifactProducer = ArtifactInstance["producer"];
export type ArtifactProjectionCursor =
  typeof artifactProjectionCursors.$inferSelect;
export type ArtifactProjectionCursorInsert =
  typeof artifactProjectionCursors.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type AssignmentStatus = Assignment["status"];
export type AssignmentEvent = typeof assignmentEvents.$inferSelect;
export type CapabilityImport = typeof capabilityImports.$inferSelect;
export type CapabilityImportInsert = typeof capabilityImports.$inferInsert;

// M16 (ADR-046): project-scoped API tokens (session-managed, sha256 at rest).
// Snake_case JS keys (matching the accounts table pattern) so that column
// accessors (eq(projectTokens.token_hash, ...)) and raw row keys align.
export const projectTokens = pgTable(
  "project_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    token_kind: text("token_kind", { enum: ["project", "user", "agent"] })
      .notNull()
      .default("project"),
    owner_user_id: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // M33 (ADR-087): per-launch ephemeral agent tokens carry the agent
    // identity; CHECK pairs it with token_kind='agent'.
    agent_id: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    prefix: text("prefix").notNull(),
    token_hash: text("token_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["*"]),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    last_used_at: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxPrefix: index("project_tokens_prefix_idx").on(t.prefix),
    idxProject: index("project_tokens_project_idx").on(t.project_id),
    idxOwner: index("project_tokens_owner_idx").on(t.owner_user_id),
    idxAgent: index("project_tokens_agent_idx").on(t.agent_id),
    agentKindCheck: check(
      "project_tokens_agent_kind_check",
      sql`(${t.token_kind} = 'agent') = (${t.agent_id} IS NOT NULL)`,
    ),
  }),
);

// M16 (ADR-046): per-call audit trail for token-authenticated requests.
// Columns use snake_case JS keys (matching the accounts table pattern) so that
// eq(schema.tokenAuditLog.token_id, ...) works in tests and returned row keys
// (which are always SQL column names) align with the JS property names.
export const tokenAuditLog = pgTable(
  "token_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token_id: text("token_id")
      .notNull()
      .references(() => projectTokens.id, { onDelete: "cascade" }),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actor_label: text("actor_label").notNull(),
    scope_used: text("scope_used").notNull(),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    result: text("result", { enum: ["ok", "error"] }).notNull(),
    status_code: integer("status_code").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxToken: index("token_audit_token_idx").on(t.token_id),
    idxProjectCreated: index("token_audit_project_created_idx").on(
      t.project_id,
      t.created_at,
    ),
  }),
);

export type ProjectToken = typeof projectTokens.$inferSelect;
export type ProjectTokenInsert = typeof projectTokens.$inferInsert;
export type TokenAuditLogRow = typeof tokenAuditLog.$inferSelect;
export type TokenAuditLogInsert = typeof tokenAuditLog.$inferInsert;

// Outbound webhooks (ADR-077). Transactional-outbox capture + singleton-drainer
// fanout/delivery. Secrets are NEVER stored: signing_secret_ref and header values
// are `env:NAME` references resolved server-side, never plaintext.
export type WebhookEventType =
  | "run.started"
  | "run.needs_input"
  | "hitl.requested"
  | "hitl.responded"
  | "run.review"
  | "run.promoted"
  | "run.done"
  | "run.failed"
  | "run.crashed"
  | "run.abandoned"
  | "gate.decided"
  | "ping";
export type WebhookErrorKind = "timeout" | "network" | "http" | "config";

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method", { enum: ["POST", "PUT"] })
      .notNull()
      .default("POST"),
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    eventTypes: jsonb("event_types").$type<string[]>().notNull(),
    signingSecretRef: text("signing_secret_ref").notNull(),
    secondarySigningSecretRef: text("secondary_signing_secret_ref"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProject: index("webhook_subscriptions_project_idx").on(t.projectId),
  }),
);
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type WebhookSubscriptionInsert =
  typeof webhookSubscriptions.$inferInsert;

// Transactional outbox: rows captured at emit; fanout_at IS NULL is the entire
// fanout cursor. `payload` is the frozen envelope, built at fanout.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    fanoutAt: timestamp("fanout_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxPendingFanout: index("webhook_events_pending_fanout_idx")
      .on(t.createdAt)
      .where(sql`${t.fanoutAt} IS NULL`),
  }),
);
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type WebhookEventInsert = typeof webhookEvents.$inferInsert;

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => webhookEvents.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "delivered", "dead"] })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    lastHttpStatus: integer("last_http_status"),
    lastErrorKind: text("last_error_kind", {
      enum: ["timeout", "network", "http", "config"],
    }),
    lastErrorMessage: text("last_error_message"),
    deliveredAt: timestamp("delivered_at", {
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
    uniqSubscriptionEvent: uniqueIndex("webhook_deliveries_sub_event_uq").on(
      t.subscriptionId,
      t.eventId,
    ),
    idxDue: index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    idxSubscriptionLog: index("webhook_deliveries_subscription_log_idx").on(
      t.subscriptionId,
      t.createdAt.desc(),
    ),
  }),
);
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type WebhookDeliveryInsert = typeof webhookDeliveries.$inferInsert;

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    httpStatus: integer("http_status"),
    errorKind: text("error_kind", {
      enum: ["timeout", "network", "http", "config"],
    }),
    errorDetail: text("error_detail"),
    responseSnippet: text("response_snippet"),
  },
  (t) => ({
    uniqDeliveryAttempt: uniqueIndex(
      "webhook_delivery_attempts_delivery_attempt_uq",
    ).on(t.deliveryId, t.attemptNo),
    idxDelivery: index("webhook_delivery_attempts_delivery_idx").on(
      t.deliveryId,
    ),
  }),
);
export type WebhookDeliveryAttempt =
  typeof webhookDeliveryAttempts.$inferSelect;
export type WebhookDeliveryAttemptInsert =
  typeof webhookDeliveryAttempts.$inferInsert;

// --- ADR-083: social board substrate ----------------------------------------

// Polymorphic actor pair on all four social tables: no FK to users (a deleted
// user renders as a "former user" fallback); Stage 1 writes user/system only.

export const taskRelations = pgTable(
  "task_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromTaskId: text("from_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["blocks", "depends_on", "parent_of"],
    }).notNull(),
    toTaskId: text("to_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["user", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRelation: unique("task_relations_from_kind_to_uq").on(
      t.fromTaskId,
      t.kind,
      t.toTaskId,
    ),
    idxToTask: index("task_relations_to_task_idx").on(t.toTaskId),
    kindCheck: check(
      "task_relations_kind_check",
      sql`${t.kind} in ('blocks', 'depends_on', 'parent_of')`,
    ),
    noSelfCheck: check(
      "task_relations_no_self_check",
      sql`${t.fromTaskId} <> ${t.toTaskId}`,
    ),
    actorTypeCheck: check(
      "task_relations_actor_type_check",
      sql`${t.actorType} in ('user', 'agent', 'system')`,
    ),
    actorPairCheck: check(
      "task_relations_actor_pair_check",
      sql`(${t.actorType} = 'system') = (${t.actorId} is null)`,
    ),
  }),
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["user", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxTaskCreated: index("task_comments_task_created_idx").on(
      t.taskId,
      t.createdAt,
    ),
    actorTypeCheck: check(
      "task_comments_actor_type_check",
      sql`${t.actorType} in ('user', 'agent', 'system')`,
    ),
    actorPairCheck: check(
      "task_comments_actor_pair_check",
      sql`(${t.actorType} = 'system') = (${t.actorId} is null)`,
    ),
  }),
);

export const TASK_ACTIVITY_EVENT_KINDS = [
  "task_created",
  "comment_added",
  "task_mentioned",
  "relation_added",
  "relation_removed",
  "run_launched",
] as const;

export type TaskActivityEventKind = (typeof TASK_ACTIVITY_EVENT_KINDS)[number];

export const taskActivity = pgTable(
  "task_activity",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["user", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    eventKind: text("event_kind", {
      enum: TASK_ACTIVITY_EVENT_KINDS,
    }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxTaskCreated: index("task_activity_task_created_idx").on(
      t.taskId,
      t.createdAt,
    ),
    idxProjectCreated: index("task_activity_project_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
    eventKindCheck: check(
      "task_activity_event_kind_check",
      sql`${t.eventKind} in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched')`,
    ),
    actorTypeCheck: check(
      "task_activity_actor_type_check",
      sql`${t.actorType} in ('user', 'agent', 'system')`,
    ),
    actorPairCheck: check(
      "task_activity_actor_pair_check",
      sql`(${t.actorType} = 'system') = (${t.actorId} is null)`,
    ),
  }),
);

export const taskSubscribers = pgTable(
  "task_subscribers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    subscriberType: text("subscriber_type", {
      enum: ["user", "agent"],
    }).notNull(),
    subscriberId: text("subscriber_id").notNull(),
    reason: text("reason", {
      enum: ["creator", "commenter", "mentioned", "manual"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqPair: unique("task_subscribers_task_pair_uq").on(
      t.taskId,
      t.subscriberType,
      t.subscriberId,
    ),
    subscriberTypeCheck: check(
      "task_subscribers_type_check",
      sql`${t.subscriberType} in ('user', 'agent')`,
    ),
    reasonCheck: check(
      "task_subscribers_reason_check",
      sql`${t.reason} in ('creator', 'commenter', 'mentioned', 'manual')`,
    ),
  }),
);

export type InboxSourceRef = {
  kind: "comment" | "mention";
  taskId: string;
  commentId: string;
  activityId: string;
};

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    recipientType: text("recipient_type", {
      enum: ["user", "agent"],
    }).notNull(),
    recipientId: text("recipient_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    eventKind: text("event_kind", {
      enum: TASK_ACTIVITY_EVENT_KINDS,
    }).notNull(),
    sourceRef: jsonb("source_ref").$type<InboxSourceRef>().notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxRecipient: index("inbox_items_recipient_idx").on(
      t.recipientType,
      t.recipientId,
      t.readAt,
      t.createdAt,
    ),
    recipientTypeCheck: check(
      "inbox_items_recipient_type_check",
      sql`${t.recipientType} in ('user', 'agent')`,
    ),
    eventKindCheck: check(
      "inbox_items_event_kind_check",
      sql`${t.eventKind} in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched')`,
    ),
  }),
);

export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type TaskRelationInsert = typeof taskRelations.$inferInsert;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type TaskCommentInsert = typeof taskComments.$inferInsert;
export type TaskActivityRow = typeof taskActivity.$inferSelect;
export type TaskActivityInsert = typeof taskActivity.$inferInsert;
export type TaskSubscriberRow = typeof taskSubscribers.$inferSelect;
export type TaskSubscriberInsert = typeof taskSubscribers.$inferInsert;
export type InboxItemRow = typeof inboxItems.$inferSelect;
export type InboxItemInsert = typeof inboxItems.$inferInsert;

// Domain-event outbox (ADR-086): append-only fact log + per-consumer cursor
// rows — the shared trigger bus. Emission rides the domain write's transaction
// (`emitDomainEvent`, CAS-winner path only). Dispatch reads are PK-range scans
// gated by the xid8 commit horizon (`tx_id < pg_snapshot_xmin(...)`) so a
// late-committing lower id is never skipped. No UPDATE/DELETE app paths; no
// pruning in this stage (a future prune must honor min(cursor_event_id)).
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const domainEvents = pgTable(
  "domain_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: DOMAIN_EVENT_KINDS }).notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    actorType: text("actor_type", { enum: ["user", "system", "agent"] }),
    actorId: text("actor_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    txId: xid8("tx_id")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => ({
    kindCheck: check(
      "domain_events_kind_check",
      sql`${t.kind} in ('task.created', 'task.comment_added', 'task.triage_requeued', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'gate.failed')`,
    ),
    actorTypeCheck: check(
      "domain_events_actor_type_check",
      sql`${t.actorType} in ('user', 'system', 'agent')`,
    ),
  }),
);
export type DomainEventRow = typeof domainEvents.$inferSelect;
export type DomainEventInsert = typeof domainEvents.$inferInsert;

export const domainEventConsumers = pgTable("domain_event_consumers", {
  consumerId: text("consumer_id").primaryKey(),
  cursorEventId: bigint("cursor_event_id", { mode: "number" })
    .notNull()
    .default(0),
  leaseExpiresAt: timestamp("lease_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastDispatchedAt: timestamp("last_dispatched_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
export type DomainEventConsumerRow = typeof domainEventConsumers.$inferSelect;
export type DomainEventConsumerInsert =
  typeof domainEventConsumers.$inferInsert;
