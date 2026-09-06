import type {
  DeliveryPolicy,
  StoredDeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import type {
  ContextMountSnapshot,
  ContextRepoDecl,
} from "@/lib/context-mounts/types";
import type {
  DelegationBounds,
  ResultProfileMap,
  RunResultArtifactRef,
  RunResultContract,
  RunResultInvalidReason,
  RunResultProducerKind,
  RunResultValidity,
} from "@/lib/run-results/types";
import type { BudgetState, ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { TaskQueueSettings } from "@/lib/tasks/queue-settings";
import type {
  AutoPromotionConfig,
  LaneClass,
} from "@/lib/auto-promotion/config";
import type { PromotionHold } from "@/lib/auto-promotion/types";
import type { RunnerResolutionWarning } from "@/lib/acp-runners/resolve";
import type { ScheduledLaunchRequest } from "@/lib/scheduled-launches/types";
import type {
  EvaluationMethodCompat,
  EvaluationPanelPolicy,
  EvaluationPanelRoleBinding,
  EvaluationRecipeDefinition,
  EvaluationRunIdentitySnapshot,
} from "@/lib/evaluations/types";
import type { PromptOwnerReference } from "@/lib/execution-host/prompt-owner-contract";
import type { CommandApplicationError } from "@/lib/execution-host/types";
import type { CommandReceipt } from "@/lib/execution-host/contracts";

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  type AnyPgColumn,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
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
import { PROMPT_OWNER_SHAPES } from "@/lib/execution-host/prompt-owner-contract";
import {
  ASSIGNMENT_STATES,
  COMMAND_KINDS,
  COMMAND_STATES,
  COMMAND_APPLICATION_STATES,
  COMMAND_TRANSPORT_STATES,
  EXECUTION_HOST_KINDS,
  EXECUTION_HOST_READINESS,
  OPEN_COMMAND_STATES,
  PLACEMENT_REASONS,
  RUNTIME_OBJECT_KINDS,
  RUNTIME_OBJECT_RETENTION_CLASSES,
  RUNTIME_OBJECT_STATES,
  TERMINAL_COMMAND_STATES,
} from "@/lib/execution-host/types";

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

// Renders `<col> in ('a', 'b')` for a CHECK from a shared constant array so the
// DB constraint aliases the TypeScript vocabulary instead of hand-mirroring it.
function inLiteralList(
  column: AnyPgColumn,
  values: readonly string[],
): ReturnType<typeof sql> {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  repoUrl: text("repo_url"),
  provider: text("provider"),
  mainBranch: text("main_branch").notNull().default("main"),
  branchPrefix: text("branch_prefix").notNull().default("maister/"),
  // ADR-093: nullable — NULL = config lives only in the DB (registered with no
  // maister.yaml on disk; the manifest is optional at manual registration).
  maisterYamlPath: text("maister_yaml_path"),
  defaultRunnerId: text("default_runner_id"),
  // ADR-141 (migration 0106): branch-sync defaults. `sync_strategy_default` is
  // the project's default rebase|merge strategy; `sync_runner_id` is the resolver
  // runner (nullable FK, SET NULL on runner delete — mirrors
  // flowRevisions.defaultRunnerId, NOT the plain-text projects.default_runner_id).
  syncStrategyDefault: text("sync_strategy_default", {
    enum: ["rebase", "merge"],
  })
    .notNull()
    .default("rebase"),
  syncRunnerId: text("sync_runner_id").references(() => platformAcpRunners.id, {
    onDelete: "set null",
  }),
  promotionMode: text("promotion_mode"),
  deliveryPolicyDefault: jsonb(
    "delivery_policy_default",
  ).$type<StoredDeliveryPolicy | null>(),
  executionPolicyDefault: jsonb(
    "execution_policy_default",
  ).$type<ExecutionPolicy | null>(),
  // ADR-121: per-project queue settings (`{ edgeDrain?, maxInFlightAuto? }`).
  // NULL ⇒ env defaults apply (resolved live at admission, never snapshotted).
  taskQueueSettings: jsonb(
    "task_queue_settings",
  ).$type<TaskQueueSettings | null>(),
  // ADR-126: auto-promotion lane config. NULL ⇒ shipped defaults with master OFF
  // (resolved live via resolveAutoPromotionConfig, never snapshotted — the sweep
  // enforces current operator intent, D-8).
  autoPromotion: jsonb("auto_promotion").$type<AutoPromotionConfig | null>(),
  // ADR-122 (Project Brain): Brain on for this repo. Enable-gate refuses CONFIG
  // unless platform embedding + distill config are set (a project can never be
  // enabled into an unharvest-able state).
  brainEnabled: boolean("brain_enabled").notNull().default(false),
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
  env?: Record<string, string>;
  provider?: PlatformRunnerProvider;
  providerKind: string;
  permissionPolicy: string;
};

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
    env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
    permissionPolicy: text("permission_policy", {
      enum: ["default", "dangerously_skip_permissions"],
    })
      .notNull()
      .default("default"),
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
  }),
);

export const platformRuntimeSettings = pgTable("platform_runtime_settings", {
  id: text("id").primaryKey().default("singleton"),
  defaultRunnerId: text("default_runner_id")
    .notNull()
    .references(() => platformAcpRunners.id),
  webhooksEnabled: boolean("webhooks_enabled").notNull().default(true),
  // ADR-122 (Project Brain): OpenAI-compatible embedding + distillation provider
  // config. All nullable. API keys are `env:NAME` references only — never the
  // raw secret. Changing embedding_model/embedding_dimensions is a reindex
  // generation, never a schema migration.
  embeddingBaseUrl: text("embedding_base_url"),
  embeddingModel: text("embedding_model"),
  embeddingDimensions: integer("embedding_dimensions"),
  embeddingApiKeyRef: text("embedding_api_key_ref"),
  distillBaseUrl: text("distill_base_url"),
  distillModel: text("distill_model"),
  distillApiKeyRef: text("distill_api_key_ref"),
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
    lastProbeStatus: text("last_probe_status", { enum: ["Ok", "Failed"] }),
    lastProbeAt: timestamp("last_probe_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastProbeReason: text("last_probe_reason"),
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
    // ADR-165 (0129): the package's NAMED agent result contracts, resolved at
    // install for EVERY member flow in the same statement that writes the
    // revision. A delegated agent child's `resultProfile` resolves against THIS
    // map on the parent run's PINNED revision. NULL = the package declares none.
    resultProfiles: jsonb("result_profiles").$type<ResultProfileMap>(),
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
    // ADR-088: membership in an attached package group (null = standalone).
    // Detach removes the group in its own transaction — no ON DELETE action.
    packageInstallId: text("package_install_id").references(
      () => packageInstalls.id,
    ),
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
  | "domain_event_dispatch"
  | "auto_launch_triaged"
  | "auto_promote"
  | "repo_delivery_scan"
  | "pr_state_scan"
  | "evaluation_dispatch"
  | "evaluation_suite_scan";
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
        "auto_launch_triaged",
        "auto_promote",
        "repo_delivery_scan",
        "pr_state_scan",
        "evaluation_dispatch",
        "evaluation_suite_scan",
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
        "auto_launch_triaged",
        "auto_promote",
        "repo_delivery_scan",
        "pr_state_scan",
        "evaluation_dispatch",
        "evaluation_suite_scan",
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

export type AgentWorkspace = "none" | "repo_read" | "worktree";
export type AgentMode = "session" | "subagent";
export type AgentRiskTier = "read_only" | "standard" | "destructive";
export type AgentTriggerKind =
  | "manual"
  | "cron"
  | "domain_event"
  | "webhook"
  | "flow";
export type AgentOrigin = "git" | "authored";
// Per-agent runner-policy recommendation (ADR-106): a simplified projection
// over the rich ExecutionPolicy (lib/runs/execution-policy.ts). `autoApply`
// maps to the B1 permissions + B2 humanGate axes; `onBudgetBreach` is the new
// budget terminal-handling axis. It seeds the per-project agent instance; the
// effective resolution + enforcement land in Phase 5.
export type AgentExecutionPolicyRecommendation = {
  autoApply?: "off" | "permissions" | "full";
  onBudgetBreach?: "escalate" | "terminate" | "terminate_restorable";
};

// ADR-111: a generic agent-config parameter the package declares. Projected
// onto `agents.config_schema`; the per-project instance value lives on
// `agent_project_links.config`; the resolved map is snapshotted onto
// `runs.agent_config` at launch. `values` is meaningful only for `enum`.
export type AgentConfigParam = {
  key: string;
  type: "boolean" | "enum" | "string" | "number";
  default?: boolean | string | number;
  label?: string;
  description?: string;
  values?: string[];
};

// Package-recommended bindings (ADR-089 rework, extended ADR-106): pre-fill the
// attach panel and seed the per-project agent instance defaults.
export type AgentRecommended = {
  runner?: string;
  branch_base?: string;
  cron?: { expr: string; timezone: string };
  events?: string[];
  // ADR-151: prefills a trigger_type='mention' binding row in the attach
  // modal. A recommendation, never an implicit grant — only a project admin
  // saving that row actually makes the agent summonable.
  mention?: boolean;
  executionPolicy?: AgentExecutionPolicyRecommendation;
};

export const agents = pgTable(
  "agents",
  {
    // Package-qualified id `<packageName>:<file-stem>` (ADR-106 re-key) — the
    // definition is `maister-agents/<stem>.md` at the providing package ROOT,
    // so two packages shipping the same stem register as distinct agents.
    id: text("id").primaryKey(),
    // Provenance: the providing package name (= package_installs.name) + the
    // newest registered version. The catalog row is a projection; the
    // per-project EFFECTIVE definition resolves through that project's attached
    // package install's pinned revision at launch (ADR-106; was flowRefId).
    packageName: text("package_name").notNull(),
    versionLabel: text("version_label").notNull(),
    origin: text("origin", { enum: ["git", "authored"] }).notNull(),
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
    recommended: jsonb("recommended").$type<AgentRecommended>(),
    // (ADR-111) The declared generic config params, projected from the .md's
    // `config:` block on every resync (SET/CLEAR symmetric: absent → null).
    configSchema: jsonb("config_schema").$type<AgentConfigParam[]>(),
    // (ADR-106) The same-package flow this agent drives (a manifest flow id);
    // null → standalone ACP-session agent. WITH it, launching runs that flow
    // (run_kind='flow') with the agent's .md augmenting every ai_coding node.
    flowRef: text("flow_ref"),
    // (ADR-106) Agent branch base; null → defaults to the project main branch.
    // Seeded from recommended.branch_base, overridable per-instance.
    branchBase: text("branch_base"),
    // `trigger` or a literal branch name; only valid with workspace=repo_read
    // (ADR-090 rework — ephemeral read-only checkout at the resolved ref).
    workspaceRef: text("workspace_ref"),
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
    idxPackageName: index("agents_package_name_idx").on(t.packageName),
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
    // (ADR-106) Per-instance overrides: branch base + the {autoApply,
    // onBudgetBreach} policy. null → fall back to the agent `recommended`
    // (then project/platform default). Effective resolution is Phase 5.
    branchBase: text("branch_base"),
    executionPolicyOverride: jsonb(
      "execution_policy_override",
    ).$type<AgentExecutionPolicyRecommendation>(),
    // (ADR-111) Per-instance config values keyed by the declared param key;
    // null → all declared defaults. Sparse: only keys the operator set. The
    // resolved (defaults ← instance) map is snapshotted onto runs.agent_config.
    config: jsonb("config").$type<Record<string, unknown>>(),
    // ADR-122 (Project Brain): per-link access axes. can_read_brain gates
    // recall; can_write_brain gates retain (separate axis — a read grant NEVER
    // opens retain, the memory-poisoning guard). can_propose_brain = Sub-project C.
    canReadBrain: boolean("can_read_brain").notNull().default(false),
    canWriteBrain: boolean("can_write_brain").notNull().default(false),
    // ADR-152: a SEPARATE store from Brain. Neither can_read_brain nor
    // can_write_brain implies it, and the `agent_memory:write` token scope
    // alone does not authorize a write — both must pass.
    memoryEnabled: boolean("memory_enabled").notNull().default(false),
    // ADR-156: lets an agent token minted in ANOTHER project act in this one,
    // limited to CROSS_PROJECT_AGENT_SCOPES. The owner's per-project attach
    // confirmation is the consent event, so the grant lives on the attachment
    // rather than in a new table. DEFAULT false = deny-by-default, the honest
    // meaning for every pre-0123 row.
    crossProjectReach: boolean("cross_project_reach").notNull().default(false),
    // ADR-157: read-only sibling repos this attachment's runs may READ. The
    // ATTACHMENT is the config point because a project admin confirms it per
    // project; the definition's `recommended.context_repos` is prefill only,
    // since package slugs are not portable across installations. NULL = none
    // declared (the honest meaning for every pre-0124 row).
    contextRepos: jsonb("context_repos").$type<ContextRepoDecl[]>(),
    // ADR-140: fences full-replacement binding saves so a stale editor cannot
    // erase telemetry or bindings added after it loaded the attachment.
    schedulesRevision: integer("schedules_revision").notNull().default(1),
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

// M34 (ADR-089) rework of the dead M24 shape: real agents FK (was text
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
    // ADR-151: `mention` rows carry no cron and no event_match — both shape
    // CHECKs are `<>`-guarded, and the column itself has no value CHECK, so
    // the third value needed no migration.
    triggerType: text("trigger_type", {
      enum: ["cron", "event", "mention"],
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
    lastAttemptAt: timestamp("last_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastAttemptFence: integer("last_attempt_fence"),
    lastOutcome: text("last_outcome", {
      enum: [
        "launched",
        "queued",
        "refused",
        "deduplicated",
        "suppressed",
        "failed",
      ],
    }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    // The run link is intentionally an audit pointer. The owning Run keeps the
    // actual nullable FK to this binding, avoiding a circular schema initializer.
    lastRunId: text("last_run_id"),
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

export const scheduledTaskLaunches = pgTable(
  "scheduled_task_launches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    taskKey: text("task_key").notNull(),
    taskNumber: integer("task_number").notNull(),
    taskTitle: text("task_title").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastActorUserId: text("last_actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    scheduledLocalTime: text("scheduled_local_time").notNull(),
    timezone: text("timezone").notNull(),
    disambiguation: text("disambiguation", {
      enum: ["earlier", "later"],
    }),
    scheduledForAt: timestamp("scheduled_for_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    armedAt: timestamp("armed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    launchRequest: jsonb("launch_request")
      .$type<ScheduledLaunchRequest>()
      .notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", {
      enum: [
        "Scheduled",
        "Dispatching",
        "RetryWaiting",
        "Launched",
        "Failed",
        "Cancelled",
      ],
    })
      .notNull()
      .default("Scheduled"),
    revision: integer("revision").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    claimId: text("claim_id"),
    claimFence: integer("claim_fence"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    claimOrigin: text("claim_origin", { enum: ["tick", "run_now"] }),
    latestOutcome: text("latest_outcome", {
      enum: [
        "created",
        "rearmed",
        "claimed",
        "retry_scheduled",
        "cancelled",
        "launched",
        "failed",
      ],
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    lateByMs: bigint("late_by_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectCreatorIdempotency: unique(
      "scheduled_task_launches_project_creator_idempotency_uq",
    ).on(t.projectId, t.createdByUserId, t.idempotencyKey),
    idxProject: index("scheduled_task_launches_project_idx").on(
      t.projectId,
      t.updatedAt,
    ),
    idxDue: index("scheduled_task_launches_due_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.state} IN ('Scheduled', 'RetryWaiting')`),
    stateShapeCheck: check(
      "scheduled_task_launches_state_shape_check",
      sql`(
        ${t.state} = 'Dispatching'
        AND ${t.claimId} IS NOT NULL
        AND ${t.claimFence} IS NOT NULL
        AND ${t.claimExpiresAt} IS NOT NULL
        AND ${t.claimOrigin} IS NOT NULL
      ) OR (
        ${t.state} <> 'Dispatching'
        AND ${t.claimId} IS NULL
        AND ${t.claimFence} IS NULL
        AND ${t.claimExpiresAt} IS NULL
        AND ${t.claimOrigin} IS NULL
      )`,
    ),
    attemptsCheck: check(
      "scheduled_task_launches_attempts_check",
      sql`${t.attemptCount} >= 0 AND ${t.attemptCount} <= ${t.maxAttempts} AND ${t.maxAttempts} = 3`,
    ),
    revisionCheck: check(
      "scheduled_task_launches_revision_check",
      sql`${t.revision} >= 1`,
    ),
  }),
);

export const scheduledTaskLaunchAttempts = pgTable(
  "scheduled_task_launch_attempts",
  {
    id: text("id").primaryKey(),
    scheduledLaunchId: text("scheduled_launch_id")
      .notNull()
      .references(() => scheduledTaskLaunches.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    taskAttemptNumber: integer("task_attempt_number").notNull(),
    branch: text("branch").notNull(),
    worktreePath: text("worktree_path").notNull(),
    requestHash: text("request_hash").notNull(),
    claimFence: integer("claim_fence").notNull(),
    state: text("state", {
      enum: ["Reserved", "Materialized", "RunLinked", "Cleaned", "Failed"],
    })
      .notNull()
      .default("Reserved"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRun: unique("scheduled_task_launch_attempts_run_id_uq").on(t.runId),
    uniqLiveLaunch: uniqueIndex("scheduled_task_launch_attempts_launch_live_uq")
      .on(t.scheduledLaunchId)
      .where(sql`${t.state} IN ('Reserved', 'Materialized')`),
    idxLaunch: index("scheduled_task_launch_attempts_launch_idx").on(
      t.scheduledLaunchId,
      t.createdAt,
    ),
    taskAttemptCheck: check(
      "scheduled_task_launch_attempts_task_attempt_check",
      sql`${t.taskAttemptNumber} >= 1`,
    ),
  }),
);

export const scheduledTaskLaunchEvents = pgTable(
  "scheduled_task_launch_events",
  {
    id: text("id").primaryKey(),
    scheduledLaunchId: text("scheduled_launch_id")
      .notNull()
      .references(() => scheduledTaskLaunches.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "created",
        "edited_rearmed",
        "claimed",
        "retry_scheduled",
        "cancelled",
        "launched",
        "failed",
      ],
    }).notNull(),
    actorType: text("actor_type", { enum: ["user", "system"] }).notNull(),
    actorId: text("actor_id"),
    claimFence: integer("claim_fence"),
    errorCode: text("error_code"),
    message: text("message"),
    metadata: jsonb("metadata").$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxLaunchCreated: index(
      "scheduled_task_launch_events_launch_created_idx",
    ).on(t.scheduledLaunchId, t.createdAt),
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
    lockedByUserId: text("locked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lockedBySession: text("locked_by_session"),
    lockExpiresAt: timestamp("lock_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
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
    // M34 (ADR-089): NULLABLE — simple-intent tasks are created flowless and
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
    // M34 (ADR-089) launch-verdict columns: written by the ext triage op /
    // the card popover PATCH; runner rides the launchOverride tier at launch.
    triageStatus: text("triage_status", { enum: ["triaged", "flagged"] }),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    baseBranch: text("base_branch"),
    targetBranch: text("target_branch"),
    promotionMode: text("promotion_mode", {
      enum: ["local_merge", "pull_request"],
    }),
    // M37 (ADR-098, migration 0060): as-plan auto-launch. launch_mode='auto'
    // marks a task whose run the auto-launcher creates once its `requires`
    // blockers clear; delegation_spec carries the catalog-agent target + params.
    launchMode: text("launch_mode", { enum: ["auto", "manual"] }),
    // ADR-112 (migration 0073): the current enqueue intent boundary — set to
    // now() whenever launch_mode is armed 'auto' by a triage verdict, cleared
    // with it. The auto_launch_triaged retry cap counts ONLY failed flow runs
    // started at/after this instant, so a re-triage (new flow / re-arm after a
    // give-up) gets a fresh attempt budget instead of inheriting stale failures.
    launchArmedAt: timestamp("launch_armed_at", {
      withTimezone: true,
      mode: "date",
    }),
    delegationSpec: jsonb("delegation_spec").$type<TaskDelegationSpec | null>(),
    executionPolicy: jsonb("execution_policy").$type<ExecutionPolicy | null>(),
    // ADR-121: first-class priority backing the criticality dictionary. Read LIVE
    // at admission (never snapshotted onto runs) so a re-prioritization takes effect
    // for not-yet-admitted work. Closed set enforced by `tasks_priority_check`.
    priority: text("priority", {
      enum: ["low", "normal", "high", "urgent"],
    })
      .notNull()
      .default("normal"),
    // ADR-121: advisory triage confidence (0..1). NEVER read by any admission/
    // launch/routing path (INV-5) — Observatory-fed only. The DB CHECK bounds the
    // domain because numeric(4,3) precision alone permits 1.001/negatives (F4).
    triageConfidence: numeric("triage_confidence", { precision: 4, scale: 3 }),
    // ADR-121: operator pause valve — excludes the task from auto-admission (C2),
    // auto-resume (C3), and the 60s poll backstop; reversible, config-preserving.
    queuePaused: boolean("queue_paused").notNull().default(false),
    // ADR-121 F1: the two-phase C2 admission CLAIM. CAS-set under the scheduler lock
    // BEFORE `launchRun` (which is worktree-first, so no run row exists yet); cleared
    // once the run row exists or on launch failure; stale claims are reconcile-swept.
    queueClaimedAt: timestamp("queue_claimed_at", {
      withTimezone: true,
      mode: "date",
    }),
    // M39 (ADR-106): provenance + idempotency key for a task AUTO-created by an
    // agent trigger. The partial UNIQUE (agent_id, trigger_event_id) below makes
    // an at-least-once redelivery converge to ONE auto-task (mirrors the runs
    // claim). null/absent for a board-created task (which carries no trigger).
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    triggerEventId: bigint("trigger_event_id", { mode: "number" }),
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
    // M39 (ADR-106): an at-least-once trigger redelivery converges to ONE
    // auto-task (mirrors runs_agent_trigger_event_uq).
    uniqAgentTriggerEvent: uniqueIndex("tasks_agent_trigger_event_uq")
      .on(t.agentId, t.triggerEventId)
      .where(sql`${t.triggerEventId} IS NOT NULL`),
    // ADR-121: priority closed-set guard (mirrors the triageStatus text-enum
    // convention; the column enum gives TS types, the CHECK gives DB integrity).
    priorityCheck: check(
      "tasks_priority_check",
      sql`${t.priority} in ('low', 'normal', 'high', 'urgent')`,
    ),
    // ADR-121 F4: numeric(4,3) precision permits out-of-domain values; bound it.
    triageConfidenceCheck: check(
      "tasks_triage_confidence_check",
      sql`${t.triageConfidence} is null or (${t.triageConfidence} >= 0 and ${t.triageConfidence} <= 1)`,
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

// ADR-130: per-binding config overlay. Rewrites env/header/arg/url NAMES only —
// NEVER a secret value. Validated against the target's declared slots at write
// and materialization (unknown slot -> CONFIG).
export type McpConfigOverlay = {
  envRemap?: Record<string, string>; // slot NAME -> "env:OTHER_NAME"
  headerRemap?: Record<string, string>; // slot NAME -> "env:OTHER_NAME"
  argsOverride?: string[];
  urlOverride?: string;
};

// ADR-130: the explicit binding of a capability ref to a concrete MCP target in
// one project. An enabled binding wins over SOURCE_PRECEDENCE for its ref; a
// disabled binding makes the ref unresolvable (opt-out); an absent binding is
// grandfather (unchanged). target_id is polymorphic (validated app-side against
// target_kind), so it carries no DB FK — only project_id does.
export const projectMcpBindings = pgTable(
  "project_mcp_bindings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    refId: text("ref_id").notNull(),
    targetKind: text("target_kind", {
      enum: ["platform", "project", "package"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    configOverlay: jsonb("config_overlay")
      .$type<McpConfigOverlay>()
      .notNull()
      .default({}),
    recommendedHint: text("recommended_hint"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectRef: unique("project_mcp_bindings_project_ref_uq").on(
      t.projectId,
      t.refId,
    ),
    idxProject: index("project_mcp_bindings_project_idx").on(t.projectId),
    targetKindCheck: check(
      "project_mcp_bindings_target_kind_check",
      sql`${t.targetKind} in ('platform', 'project', 'package')`,
    ),
  }),
);
export type ProjectMcpBinding = typeof projectMcpBindings.$inferSelect;

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
    // M42 (ADR-114): per-slot binding key — `session:<name>` |
    // `consensus:<nodeId>:<participantId>` | `consensus:<nodeId>:synthesizer`.
    // Replaces the per-step (step_id, source_runner_id) key; slots are NEVER
    // deduped by intent.
    slotKey: text("slot_key").notNull(),
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
    uniqProjectRevisionSlot: unique(
      "flow_runner_remaps_project_revision_slot_uq",
    ).on(t.projectId, t.flowRevisionId, t.slotKey),
    idxMappedRunner: index("flow_runner_remaps_mapped_runner_idx").on(
      t.mappedRunnerId,
    ),
  }),
);

export type RunKind = "flow" | "scratch" | "agent";

export type DeliveryDiffStat = {
  files: number;
  additions: number;
  deletions: number;
};

export type RepoDeliveryRef = {
  sha: string;
  parentCount: number;
  runIds: string[];
  prNumber?: number;
  diffStat?: DeliveryDiffStat;
};

// M27/T-C8 (§3.1, ADR-069): the capability set resolved at launch, frozen onto
// the run so an edit/publish mid-run cannot mutate it. `flowOrigin` records
// whether the resolved flow revision came from the authored bridge or git.
// ADR-130: an MCP excluded from the executable set. `reason` distinguishes the
// two withhold causes; NEVER carries a secret value.
export type WithheldMcp = {
  refId: string;
  transport: "stdio" | "sse" | "http";
  reason: "platform-untrusted" | "exec-untrusted-stdio";
  scope: string;
};

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
  mcps: Array<{
    refId: string;
    sha: string | null;
    scope: string;
    // ADR-130: how this MCP won its slot. Optional so pre-migration snapshots
    // deserialize without the field.
    provenance?: "binding" | "precedence";
    boundTarget?: { kind: "platform" | "project" | "package"; id: string };
  }>;
  // ADR-130: MCPs excluded from the executable set at launch (trust / exec-trust),
  // snapshotted for run-detail visibility. Optional for pre-migration runs.
  withheldMcps?: WithheldMcp[];
};

// M37 (ADR-098): launch-time effective definition of a delegated child. Catalog
// agents keep the historical `{agentDefinitionId,revisionId}` shape; M41
// consensus runner participants use an explicit runner discriminator because
// they are server-launched and do not require catalog agent rows.
export type DelegationSnapshot =
  | {
      kind?: "agent";
      agentDefinitionId: string;
      revisionId: string;
    }
  | {
      kind: "runner";
      runnerId: string;
      participantId: string;
      nodeId: string;
      nodeAttemptId: string;
      round: number;
      workspaceMode: "repo_read";
    }
  // ADR-163: a delegated FLOW child. Carries every launch-time decision a
  // terminal or recovery path reads, so none of them has to be re-derived from
  // a live projection that may have moved since. `baseBranch`/`targetBranch`
  // both resolve to the project's main branch (a delegated child never branches
  // off its parent). `flowRevisionId` / `resolvedRevision` / the engine range
  // are written by the LAUNCHER from the revision it selected and mirror
  // `runs.flow_revision_id` (what the runner loads the manifest from) — never a
  // pin the caller resolved earlier — so advancing the project's enabled
  // revision cannot re-point a live child and the snapshot cannot disagree with
  // the run row. No DDL: the column is jsonb and this is a `$type<>` widening
  // only.
  | {
      kind: "flow";
      flowId: string;
      flowRefId: string;
      flowRevisionId: string;
      resolvedRevision: string;
      engineMin: string | null;
      engineMax: string | null;
      carrierTaskId: string;
      mode: "task" | "run";
      runnerOverride: string | null;
      baseBranch: string;
      targetBranch: string;
    };

// M37 (ADR-098, migration 0060): an as-plan task's launch intent — the
// catalog-agent target + params the auto-launcher uses when the task's
// `requires` blockers clear. Distinct from runs.delegation_snapshot (what a
// child actually launched with).
// ADR-163: a discriminated union on `kind`. Rows written before that change
// carry NO `kind`, so the agent arm's discriminant is optional and absent reads
// as "agent" — every reader goes through `delegationSpecKind` rather than
// sniffing `!spec.agentId`, which would misread a flow spec as a malformed
// agent one. No DDL: a `$type<>` widening on an existing jsonb column.
export type TaskDelegationSpec =
  | {
      kind?: "agent";
      agentId: string;
      workspace?: "none" | "repo_read" | "worktree";
      runnerOverride?: string;
      // ADR-165: the NAME the as-plan auto-launcher re-resolves at ITS launch,
      // against the parent's pinned revision. The NAME is recorded, never the
      // resolved schema, so the candidate launch and the source launch go
      // through the identical allow-list.
      resultProfile?: string;
    }
  | {
      kind: "flow";
      flowId: string;
      runnerOverride?: string;
    };

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    runKind: text("run_kind", { enum: ["flow", "scratch", "agent"] })
      .notNull()
      .default("flow"),
    // M34 (ADR-089): set iff runKind='agent'. SET NULL so run history
    // survives catalog deletes (deletes are usage-guarded for live runs).
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    triggerSource: text("trigger_source", {
      enum: ["manual", "cron", "domain_event", "webhook", "flow", "scheduled"],
    }),
    // domain_events.id claim key — partial UNIQUE (agent_id, trigger_event_id)
    // makes at-least-once redelivery converge to exactly one run.
    triggerEventId: bigint("trigger_event_id", { mode: "number" }),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    scheduledLaunchId: text("scheduled_launch_id").references(
      () => scheduledTaskLaunches.id,
      { onDelete: "set null" },
    ),
    agentScheduleId: text("agent_schedule_id").references(
      () => agentSchedules.id,
      { onDelete: "set null" },
    ),
    // ADR-150: controlled-launch idempotency handle. Written INSIDE the run
    // INSERT so a re-driven batch item adopts its existing run (partial UNIQUE
    // `runs_evaluation_batch_item_uq`) rather than minting a second — a post-hoc
    // batch_item_id -> run_id lookup double-launches across the crash window.
    // No FK: a claim token, not a relation (the batch item may be GC'd apart).
    evaluationBatchItemId: text("evaluation_batch_item_id"),
    // M34 (ADR-090): the workspace axis the run ACTUALLY launched with,
    // snapshotted from the project's pinned (effective) definition at insert.
    // Terminal L3 enforcement reads this, NOT the agents catalog index (which
    // projects the newest revision and can diverge from a project's pin).
    agentWorkspace: text("agent_workspace", {
      enum: ["none", "repo_read", "worktree"],
    }),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    // M36 Phase 5 (ADR-097): NULLABLE — a scratch-at-local-package assistant run
    // has NO project (it is rooted at a local-package working dir). Every other
    // run kind (flow/agent/project scratch) still carries a project_id; the
    // project-less variant is the ONLY null case and carries local_package_id
    // instead. Consumers branch on run_kind/null BEFORE dereferencing a project.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // M36 Phase 5 (ADR-097): launch-time snapshot of the local-package the
    // assistant session is rooted at; set iff this is a project-less scratch
    // run. Terminal/read paths read THIS snapshot, never re-deriving.
    localPackageId: text("local_package_id").references(
      () => localPackages.id,
      { onDelete: "cascade" },
    ),
    // ADR-122 (Project Brain): the launch-time decision to include ambient Brain
    // context for this run. NULL = inherit flow/agent config. Snapshots are
    // written at consumption (T4.2/T4.3), NEVER here (no recall/embedding at
    // launch). A dedicated column is required — runs.runner_snapshot no longer
    // exists post-M42 (moved to run_sessions).
    brainContext: boolean("brain_context"),
    flowId: text("flow_id").references(() => flows.id, {
      onDelete: "cascade",
    }),
    // M42 (ADR-114, migration 0082): the per-run runner mirror columns
    // (runner_id, runner_resolution_tier, capability_agent, runner_snapshot,
    // acp_session_id) + `runs_runner_idx` are DROPPED — `run_sessions` is the
    // SOLE source of truth. Every reader resolves the run's runner/resume state
    // via `loadActiveRunSession` / `loadRunSessions` / the activeSession* scalar
    // subqueries.
    status: text("status", {
      enum: [
        "Pending",
        "Running",
        "NeedsInput",
        "NeedsInputIdle",
        "HumanWorking",
        "WaitingOnChildren",
        "Review",
        "Crashed",
        "Done",
        "Abandoned",
        "Failed",
      ],
    })
      .notNull()
      .default("Pending"),
    // ADR-167: immutable at admission. B4 rejects unimported legacy rows
    // before migrations make the canonical contract the only legal mode.
    executionDataPlaneMode: text("execution_data_plane_mode", {
      enum: ["canonical_events_v1"],
    })
      .notNull()
      .default("canonical_events_v1"),
    // Allocated under the run-row lock when a contiguous canonical event is
    // accepted. Stored as bigint, never serialized through JavaScript number.
    nextExecutionEventSequence: bigint("next_execution_event_sequence", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
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
    // ADR-121 (G4): set when an idle run's HITL is answered and it awaits a slot;
    // the C3 admission FIFO key. Cleared when the run is admitted (status flips to
    // Running) so a re-idled run re-arms cleanly.
    resumeRequestedAt: timestamp("resume_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    // ADR-121 (INV-9): auto-drain ORIGIN marker — set at the run-INSERT inside
    // `launchRun` for queue-admitted (C2) runs. The precise `liveAuto` counter;
    // immutable launch-origin snapshot. NULL ⇒ manual/scratch/resume run (incl. an
    // ADR-119 force-relaunch of an auto task), which must NOT count as auto-drained.
    queueAdmittedAt: timestamp("queue_admitted_at", {
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
    // ADR-130: run-level withheld-MCP sink for flow AND agent launches (agent
    // runs persist no node_attempts materialization_plan). Nullable; never a secret.
    withheldMcps: jsonb("withheld_mcps").$type<WithheldMcp[]>(),
    deliveryPolicySnapshot: jsonb(
      "delivery_policy_snapshot",
    ).$type<DeliveryPolicy | null>(),
    // M37 (ADR-098, migration 0060): orchestrator run-tree. parent_run_id is the
    // delegator; root_run_id the tree root; delegation_snapshot the child's
    // launch-time effective agent-def; launch_mode distinguishes auto-DAG launches.
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    rootRunId: text("root_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    delegationSnapshot: jsonb(
      "delegation_snapshot",
    ).$type<DelegationSnapshot | null>(),
    launchMode: text("launch_mode", { enum: ["auto", "manual"] }),
    // M37 Phase 8 (ADR-099, migration 0060): a persistent swarm member parks
    // between turns (clean end_turn → NeedsInputIdle, acp_session_id retained)
    // instead of finalizing, and is re-messaged by addressable_key within its
    // orchestrator tree.
    persistent: boolean("persistent").notNull().default(false),
    addressableKey: text("addressable_key"),
    // M37 Phase 10 (ADR-099, migration 0060): worktree allocation mode for a
    // delegated child. null/`own` = today's per-run worktree from the base
    // branch; `shared` = N children of one root_run_id point at a single
    // pre-allocated tree with serialized writers (the promote-time guard keeps
    // at most one shared sibling Running per root). A shared-mode delegation
    // with no root_run_id is refused at launch (CONFIG).
    workspaceMode: text("workspace_mode", { enum: ["own", "shared"] }),
    // ADR-134: final target delivery evidence. Kept on the run because a shared
    // workspace can serve N runs; only the root run receives a shared-tree stat.
    promotedHeadSha: text("promoted_head_sha"),
    mergeCommitSha: text("merge_commit_sha"),
    diffStat: jsonb("diff_stat").$type<DeliveryDiffStat>(),
    executionPolicy: jsonb("execution_policy")
      .$type<ExecutionPolicy>()
      .notNull()
      .default({ preset: "supervised" }),
    // ADR-126: auto-promotion hold. NULL ⇒ no hold. Survives rework by
    // construction (never cleared by state transitions). `launch` source is
    // written at run INSERT when the launcher opts out; `system` on give-up.
    promotionHold: jsonb("promotion_hold").$type<PromotionHold | null>(),
    // ADR-126: grace-window anchor, stamped alongside status='Review' at every
    // flow Review-flip site. NULL ⇒ no anchor ⇒ fail-closed (legacy runs stay
    // manual). Re-stamped on rework re-entry ⇒ grace window restarts. Consumed
    // by no domain-event consumer (D-3 — a column, NOT a run.review emit).
    reviewEnteredAt: timestamp("review_entered_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Cost-budget governance (migration 0061): per-run mutable budget state —
    // raise-and-resume ceiling override + per-scope notified rung (idempotency).
    // Nullable: a run with no budget interaction never writes this column.
    budgetState: jsonb("budget_state").$type<BudgetState>(),
    // (ADR-111, migration 0071) The launch-time snapshot of the resolved agent
    // config (declared defaults ← instance values). Written ONCE at spawn; the
    // prompt injection reads THIS column, never re-resolving from the mutable
    // definition/link. Nullable: only agent runs with declared config write it.
    agentConfig: jsonb("agent_config").$type<Record<string, unknown>>(),
    // ADR-117 (migration 0084): durable marker for the system_sweep cost-rollup
    // backstop — the last time it ATTEMPTED a cost reconcile for this run
    // (stamped on EVERY outcome: reconciled / missing-cost / error). Decouples
    // the sweep candidate set from rollup row state so (a) a run with no
    // durable usage events is attempted once and settled instead of monopolizing the
    // bounded oldest-first scan forever, and (b) a pre-0083 rollup with empty
    // by_runner (NULL marker) is re-reconciled once to backfill it. NULL = never
    // attempted by the sweep.
    costReconciledAt: timestamp("cost_reconciled_at", {
      withTimezone: true,
      mode: "date",
    }),
    // ADR-152: sha256 of the agent memory injected into THIS run's prompt at
    // initial spawn; NULL = none injected (the honest seed for every pre-0122
    // row and every flow/scratch run). The sibling memory-snapshot.md in the
    // run dir is GC'd with that dir after 7 days, so the durable, queryable
    // answer to "what did this agent remember when it acted" has to live here.
    // Deliberately NOT folded into runner_snapshot, which resume/recover reads
    // and which must stay runner identity only.
    agentMemoryHash: text("agent_memory_hash"),
    // ADR-156: how many agent→agent trigger hops this run is deep, snapshotted
    // at launch and never re-derived. A run launched from a domain event whose
    // actor_type='agent' inherits the producing run's depth + 1; every other
    // trigger source seeds 0. Bounds BOTH the cross-project ping-pong and the
    // same-project one that `tasks:create` opens (self-exclusion only filters
    // an agent's OWN events, so an A↔B pair loops freely without this).
    // DEFAULT 0 is the honest seed for every pre-0123 row: no chain spent.
    agentChainDepth: integer("agent_chain_depth").notNull().default(0),
    // ADR-157: what this launch actually mounted, snapshotted at spawn. The
    // terminal release and crash recovery read THIS and never re-derive from the
    // manifest or the attachment, either of which can change after launch and
    // point cleanup at paths this run never created. NULL = no mounts.
    contextMounts: jsonb("context_mounts").$type<ContextMountSnapshot[]>(),
    // ADR-165 (0129): the run's PUBLIC result contract, snapshotted by the
    // launcher in the run-insert transaction — from the pinned revision's
    // `result.export` for a flow run, from the parent's pinned
    // `flow_revisions.result_profiles` for a delegated agent child. The seam,
    // the finalizer and the collect route read ONLY this snapshot, never a live
    // catalog row. NULL = no public result contract.
    resultContract: jsonb("result_contract").$type<RunResultContract>(),
    // ADR-165 (0129): the EFFECTIVE delegation bounds an orchestrator node
    // computed at its start, keyed by node attempt. Admission and the scheduler
    // read it; an env change after the snapshot cannot alter a running tree.
    // NULL = env-only bounds (a pre-3.7.0 manifest, or no orchestrator started).
    delegationBounds: jsonb("delegation_bounds").$type<DelegationBounds>(),
    // ADR-166 (migration 0130): the run's ACTIVE execution assignment (the
    // driver-ownership epoch). Circular like parent_run_id. NULL means
    // "pre-Stage-A, never placed" — historical rows keep it forever.
    executionAssignmentId: text("execution_assignment_id").references(
      (): AnyPgColumn => executionAssignments.id,
      { onDelete: "set null" },
    ),
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
    idxParentRun: index("runs_parent_run_id_idx").on(t.parentRunId),
    idxRootRun: index("runs_root_run_id_idx").on(t.rootRunId),
    idxPromotedHeadSha: index("runs_promoted_head_sha_idx")
      .on(t.promotedHeadSha)
      .where(sql`${t.promotedHeadSha} IS NOT NULL`),
    idxMergeCommitSha: index("runs_merge_commit_sha_idx")
      .on(t.mergeCommitSha)
      .where(sql`${t.mergeCommitSha} IS NOT NULL`),
    // M34 (ADR-089): outbox→spawn no-dup claim under at-least-once redelivery.
    uniqAgentTriggerEvent: uniqueIndex("runs_agent_trigger_event_uq")
      .on(t.agentId, t.triggerEventId)
      .where(sql`${t.triggerEventId} IS NOT NULL`),
    uniqScheduledLaunch: unique("runs_scheduled_launch_id_unique").on(
      t.scheduledLaunchId,
    ),
    // ADR-150: the controlled-launch seam's idempotency backstop. The run
    // INSERT's onConflictDoNothing targets this index, so a re-driven batch item
    // adopts the winner instead of double-launching.
    uniqEvaluationBatchItem: uniqueIndex("runs_evaluation_batch_item_uq")
      .on(t.evaluationBatchItemId)
      .where(sql`${t.evaluationBatchItemId} IS NOT NULL`),
    idxAgentSchedule: index("runs_agent_schedule_idx").on(t.agentScheduleId),
    // M37 Phase 8 (ADR-099): an addressable_key is unique within one
    // orchestrator tree among persistent children — the partial-index backstop
    // behind the launch.ts pre-insert check.
    uniqRootAddressableKey: uniqueIndex("runs_root_addressable_key_uq")
      .on(t.rootRunId, t.addressableKey)
      .where(sql`${t.persistent} = true`),
    // M37 (ADR-100): an as-plan/auto-DAG task launches EXACTLY ONCE over its
    // lifetime. This partial unique index is the DB backstop behind the
    // auto-launcher's hasAnyRun check-then-act — under concurrent dispatch the
    // second insert hits 23505 and launchAgentRun's onConflictDoNothing() dedups
    // it (returns {deduped}), so a released dependent can never double-launch.
    uniqAutoTask: uniqueIndex("runs_auto_task_uq")
      .on(t.taskId)
      .where(sql`${t.launchMode} = 'auto'`),
    // ADR-117 (migration 0083): supports the system_sweep cost-rollup backstop
    // reconcile's bounded `order by ended_at limit n` scan over finished runs.
    idxEndedAt: index("runs_ended_at_idx")
      .on(t.endedAt)
      .where(sql`ended_at is not null`),
    idxExecutionAssignment: index("runs_execution_assignment_idx").on(
      t.executionAssignmentId,
    ),
  }),
);

// --- Execution hosts (ADR-166, migration 0130) ------------------------------
// Postgres is the SSOT for hosts, assignments, and commands; the supervisor
// keeps its own private state (identity, fences, handles, receipts) in a
// node:sqlite file that is NOT part of this schema. All three tables are
// additive and never data-dependent.

export const executionHosts = pgTable(
  "execution_hosts",
  {
    id: text("id").primaryKey(),
    // Supervisor-minted `eh_<uuid>` or the MAISTER_EXECUTION_HOST_KEY pin.
    hostKey: text("host_key").notNull().unique(),
    kind: text("kind", { enum: EXECUTION_HOST_KINDS }).notNull(),
    displayName: text("display_name").notNull(),
    // {kind:'local_direct'} — the URL is env, never a column.
    transport: jsonb("transport").$type<{ kind: "local_direct" }>().notNull(),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    readiness: text("readiness", { enum: EXECUTION_HOST_READINESS })
      .notNull()
      .default("unknown"),
    readinessReason: text("readiness_reason"),
    lastBootId: text("last_boot_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    registeredAt: timestamp("registered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // E-EH-01: at most one non-retired local host.
    uniqLocalActive: uniqueIndex("execution_hosts_local_active_uq")
      .on(t.kind)
      .where(sql`${t.kind} = 'local_direct' AND ${t.retiredAt} IS NULL`),
    kindCheck: check(
      "execution_hosts_kind_check",
      inLiteralList(t.kind, EXECUTION_HOST_KINDS),
    ),
    readinessCheck: check(
      "execution_hosts_readiness_check",
      inLiteralList(t.readiness, EXECUTION_HOST_READINESS),
    ),
  }),
);

export const executionAssignments = pgTable(
  "execution_assignments",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // RESTRICT: a host with placement history is retired, never deleted.
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    // The driver-ownership generation; strictly increasing per run.
    epoch: integer("epoch").notNull(),
    state: text("state", { enum: ASSIGNMENT_STATES }).notNull(),
    placementReason: text("placement_reason", {
      enum: PLACEMENT_REASONS,
    }).notNull(),
    // Host-scoped opaque `ws_<uuid>` handle, copied forward on a same-host mint.
    executionWorkspaceId: text("execution_workspace_id"),
    workspaceAdoptedAt: timestamp("workspace_adopted_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Reserved for Stage C lease renewal; always NULL in Stage A.
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    supersededById: text("superseded_by_id").references(
      (): AnyPgColumn => executionAssignments.id,
      { onDelete: "set null" },
    ),
    releasedReason: text("released_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // E-EH-02: a mint never reuses an epoch (race backstop, 23505 → CONFLICT).
    uniqRunEpoch: unique("execution_assignments_run_epoch_uq").on(
      t.runId,
      t.epoch,
    ),
    // E-EH-02: at most one active assignment per run.
    uniqRunActive: uniqueIndex("execution_assignments_run_active_uq")
      .on(t.runId)
      .where(sql`${t.state} = 'active'`),
    idxHostState: index("execution_assignments_host_state_idx").on(
      t.executionHostId,
      t.state,
    ),
    epochCheck: check(
      "execution_assignments_epoch_check",
      sql`${t.epoch} >= 1`,
    ),
    stateCheck: check(
      "execution_assignments_state_check",
      inLiteralList(t.state, ASSIGNMENT_STATES),
    ),
    placementReasonCheck: check(
      "execution_assignments_placement_reason_check",
      inLiteralList(t.placementReason, PLACEMENT_REASONS),
    ),
    // An active row never carries ended_at; a terminal row always does.
    activeShapeCheck: check(
      "execution_assignments_active_shape_check",
      sql`(${t.state} = 'active') = (${t.endedAt} IS NULL)`,
    ),
  }),
);

export const executionCommands = pgTable(
  "execution_commands",
  {
    // The wire `command.id` — the host's receipt dedup key.
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionAssignmentId: text("execution_assignment_id")
      .notNull()
      .references(() => executionAssignments.id, { onDelete: "cascade" }),
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    assignmentEpoch: integer("assignment_epoch").notNull(),
    kind: text("kind", { enum: COMMAND_KINDS }).notNull(),
    targetSessionId: text("target_session_id"),
    // A per-kind ALLOW-list projection written at insert (`redactPayload`):
    // ids, names, adapter/model, counts — never a prompt body, a path, an env
    // value, or an argv/URL secret (E-EH-12).
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // ADR-167 prompt continuation identity. The digest is over canonical
    // unredacted request bytes; payload remains the existing redacted view.
    ownerKind: text("owner_kind", {
      enum: [
        "flow_node_attempt",
        "scratch_message",
        "gate_chat",
        "agent_turn",
        "sync_resolution",
      ],
    }),
    ownerRef: jsonb("owner_ref").$type<PromptOwnerReference>(),
    logicalOperationKey: text("logical_operation_key"),
    requestSchema: text("request_schema"),
    requestSha256: text("request_sha256"),
    // Private immutable replay source. Never select into browser DTOs or logs.
    requestCanonicalJson: text("request_canonical_json"),
    receiptEvidence: jsonb("receipt_evidence").$type<CommandReceipt>(),
    terminalEventId: text("terminal_event_id").references(
      (): AnyPgColumn => executionEvents.id,
      { onDelete: "restrict" },
    ),
    terminalEvidenceSha256: text("terminal_evidence_sha256"),
    transportState: text("transport_state", { enum: COMMAND_TRANSPORT_STATES })
      .notNull()
      .default("not_sent"),
    applicationState: text("application_state", {
      enum: COMMAND_APPLICATION_STATES,
    })
      .notNull()
      .default("pending"),
    applicationClaimOwner: text("application_claim_owner"),
    applicationClaimExpiresAt: timestamp("application_claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    applicationAttempts: integer("application_attempts").notNull().default(0),
    applicationNextRetryAt: timestamp("application_next_retry_at", {
      withTimezone: true,
      mode: "date",
    }),
    applicationError:
      jsonb("application_error").$type<CommandApplicationError>(),
    completionAppliedAt: timestamp("completion_applied_at", {
      withTimezone: true,
      mode: "date",
    }),
    state: text("state", { enum: COMMAND_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    deliveringSince: timestamp("delivering_since", {
      withTimezone: true,
      mode: "date",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    // Startup recovery re-delivers ONLY driverless rows (delete, release).
    driverless: boolean("driverless").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The recovery pass + deliverer due scan; `loadOpenCommands` mirrors it.
    idxOpen: index("execution_commands_open_idx")
      .on(t.state, t.nextAttemptAt)
      .where(inLiteralList(t.state, OPEN_COMMAND_STATES)),
    idxRunCreated: index("execution_commands_run_created_idx").on(
      t.runId,
      t.createdAt,
    ),
    terminalEvidenceCheck: check(
      "execution_commands_terminal_evidence_check",
      sql`${t.terminalEvidenceSha256} IS NULL OR (${t.terminalEvidenceSha256} ~ '^[a-f0-9]{64}$' AND ${t.terminalEventId} IS NOT NULL AND ${t.receiptEvidence} IS NOT NULL)`,
    ),
    receiptEvidenceCheck: check(
      "execution_commands_receipt_evidence_check",
      sql`${t.receiptEvidence} IS NULL OR (jsonb_typeof(${t.receiptEvidence}) = 'object' AND ${t.receiptEvidence}->>'commandId' = ${t.id} AND ${t.receiptEvidence}->>'runId' = ${t.runId} AND ${t.receiptEvidence}->>'kind' = ${t.kind} AND ${t.receiptEvidence}->>'assignmentEpoch' = ${t.assignmentEpoch}::text AND ${t.receiptEvidence}->>'phase' IN ('completed', 'rejected')) IS TRUE`,
    ),
    idxTerminalEvent: index("execution_commands_terminal_event_idx")
      .on(t.terminalEventId)
      .where(sql`${t.terminalEventId} IS NOT NULL`),
    idxAssignment: index("execution_commands_assignment_idx").on(
      t.executionAssignmentId,
    ),
    idxReconciliation: index("execution_commands_reconciliation_idx")
      .on(t.transportState, t.nextAttemptAt, t.id)
      .where(
        sql`${t.requestSchema} = 'maister.command.request.v2' AND ${t.transportState} IN ('unknown', 'reconciliation_required')`,
      ),
    idxApplication: index("execution_commands_application_idx")
      .on(
        t.applicationState,
        t.applicationNextRetryAt,
        t.applicationClaimExpiresAt,
        t.id,
      )
      .where(
        sql`${t.requestSchema} = 'maister.command.request.v2' AND ${t.kind} = 'session.prompt' AND ${t.applicationState} IN ('pending', 'applying')`,
      ),
    uniqPromptLogicalOperation: uniqueIndex(
      "execution_commands_prompt_logical_operation_uq",
    )
      .on(t.runId, t.logicalOperationKey)
      .where(
        sql`${t.kind} = 'session.prompt' AND ${t.logicalOperationKey} IS NOT NULL`,
      ),
    kindCheck: check(
      "execution_commands_kind_check",
      inLiteralList(t.kind, COMMAND_KINDS),
    ),
    stateCheck: check(
      "execution_commands_state_check",
      inLiteralList(t.state, COMMAND_STATES),
    ),
    terminalShapeCheck: check(
      "execution_commands_terminal_shape_check",
      sql`(${inLiteralList(t.state, TERMINAL_COMMAND_STATES)}) = (${t.completedAt} IS NOT NULL)`,
    ),
    ownerShapeCheck: check(
      "execution_commands_owner_shape_check",
      sql`(${t.ownerKind} IS NULL AND ${t.ownerRef} IS NULL AND ${t.logicalOperationKey} IS NULL AND ${t.requestSchema} IS NULL AND ${t.requestSha256} IS NULL) OR (${t.ownerKind} IN ('flow_node_attempt', 'scratch_message', 'gate_chat', 'agent_turn', 'sync_resolution') AND jsonb_typeof(${t.ownerRef}) = 'object' AND ${t.logicalOperationKey} IS NOT NULL AND ${t.requestSchema} IS NOT NULL AND ${t.requestSha256} ~ '^[a-f0-9]{64}$')`,
    ),
    requestShapeCheck: check(
      "execution_commands_request_v2_check",
      sql`(((${t.requestSchema} IS DISTINCT FROM 'maister.command.request.v2') AND ${t.requestCanonicalJson} IS NULL) OR
        (${t.requestSchema} = 'maister.command.request.v2' AND ${t.kind} = 'session.prompt'
        AND ${t.requestCanonicalJson} IS NOT NULL AND ${t.targetSessionId} IS NOT NULL
        AND ${t.ownerKind} IS NOT NULL AND ${t.ownerRef} IS NOT NULL
        AND length(${t.logicalOperationKey}) BETWEEN 1 AND 256
        AND ${t.requestSha256} = encode(sha256(convert_to(${t.requestCanonicalJson}, 'UTF8')), 'hex')
        AND (${t.requestCanonicalJson}::jsonb->'requestVersion') = '2'::jsonb
        AND (${t.requestCanonicalJson}::jsonb->'command'->>'id') = ${t.id}
        AND (${t.requestCanonicalJson}::jsonb->'command'->>'kind') = ${t.kind}
        AND (${t.requestCanonicalJson}::jsonb->'fence'->>'runId') = ${t.runId}
        AND (${t.requestCanonicalJson}::jsonb->'fence'->>'assignmentId') = ${t.executionAssignmentId}
        AND (${t.requestCanonicalJson}::jsonb->'fence'->'assignmentEpoch') = to_jsonb(${t.assignmentEpoch})
        AND (${t.requestCanonicalJson}::jsonb->'target'->>'hostSessionId') = ${t.targetSessionId}
        AND (${t.ownerRef}->>'runId') = ${t.runId}
        AND (${t.ownerRef}->>'assignmentId') = ${t.executionAssignmentId}
        AND (${t.ownerRef}->'assignmentEpoch') = to_jsonb(${t.assignmentEpoch})
        AND (${t.ownerRef}->'version') = '1'::jsonb
        AND (${sql.join(
          PROMPT_OWNER_SHAPES.map(({ kind, variant, keys }) => {
            const allowed = sql.raw(
              `ARRAY[${keys.map((key) => `'${key}'`).join(",")}]::text[]`,
            );
            const fields = keys.map((key) => {
              const name = sql.raw(`'${key}'`);

              return [
                "version",
                "assignmentEpoch",
                "promptOrdinal",
                "round",
              ].includes(key)
                ? sql`CASE WHEN jsonb_typeof(${t.ownerRef}->${name}) = 'number' THEN (${t.ownerRef}->>${name})::numeric BETWEEN 0 AND 9007199254740991 AND (${t.ownerRef}->>${name}) ~ '^[0-9]+$' ELSE false END`
                : sql`jsonb_typeof(${t.ownerRef}->${name}) = 'string' AND length(${t.ownerRef}->>${name}) BETWEEN 1 AND 128`;
            });

            return sql`(${t.ownerKind} = ${sql.raw(`'${kind}'`)} AND ${t.ownerRef}->>'variant' = ${sql.raw(`'${variant}'`)} AND ${t.ownerRef} ?& ${allowed} AND ${t.ownerRef} - ${allowed} = '{}'::jsonb AND ${sql.join(fields, sql` AND `)}${variant === "resolver" ? sql` AND ${t.ownerRef}->>'expectedPhase' = 'agent_running'` : sql``})`;
          }),
          sql` OR `,
        )}))) IS TRUE`,
    ),
    transportStateCheck: check(
      "execution_commands_transport_state_check",
      inLiteralList(t.transportState, COMMAND_TRANSPORT_STATES),
    ),
    applicationStateCheck: check(
      "execution_commands_application_state_check",
      inLiteralList(t.applicationState, COMMAND_APPLICATION_STATES),
    ),
    applicationShapeCheck: check(
      "execution_commands_application_shape_check",
      sql`
      (${t.applicationState} = 'applied') = (${t.completionAppliedAt} IS NOT NULL)
      AND (${t.applicationState} = 'applying') = (${t.applicationClaimOwner} IS NOT NULL AND ${t.applicationClaimExpiresAt} IS NOT NULL)
      AND (${t.applicationClaimOwner} IS NULL) = (${t.applicationClaimExpiresAt} IS NULL)
      AND ${t.applicationAttempts} >= 0
      AND (${t.applicationState} != 'poisoned' OR ${t.applicationNextRetryAt} IS NULL)`,
    ),
  }),
);

export type ExecutionHost = typeof executionHosts.$inferSelect;
export type ExecutionAssignment = typeof executionAssignments.$inferSelect;
export type ExecutionCommand = typeof executionCommands.$inferSelect;

// --- Evaluation Lab (M46, ADR-142..145) ------------------------------------
// The neutral Study/participant/recipe model that supersedes the task-bound
// Experiment coupling (ADR-124). Foundational tables only — the platform-config
// (0105) and execution/evidence (0106) tables land in later migrations. A
// migrated legacy Experiment keeps its id as the Study id and records
// `legacy_experiment_id` (ADR-139 D1/D2).

export const evaluationStudies = pgTable(
  "evaluation_studies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // RESTRICT: a task cannot be deleted while a Study references it — the Study
    // must be archived/deleted first (ADR-139 D2). Distinct from experiments,
    // which cascade.
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    purpose: text("purpose"),
    status: text("status", {
      enum: ["draft", "open", "decided", "archived"],
    })
      .notNull()
      .default("draft"),
    // Optimistic-concurrency guard; PATCH/DELETE require If-Match on this.
    version: integer("version").notNull().default(1),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Set only for Studies migrated from a legacy Experiment; UNIQUE so the
    // 0090->0104 backfill is one-to-one. Nullable columns allow many NULLs in a
    // Postgres UNIQUE, so new Studies (NULL) never collide.
    legacyExperimentId: text("legacy_experiment_id"),
    archivedReason: text("archived_reason"),
    // The original Experiment row preserved verbatim at backfill time so the
    // Study stays self-contained now that migration 0120 (ADR-150) has dropped
    // the experiments table. Null for natively-created Studies.
    legacySnapshot: jsonb("legacy_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxProjectStatus: index("evaluation_studies_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    idxTask: index("evaluation_studies_task_idx").on(t.taskId),
    uniqLegacyExperiment: unique("evaluation_studies_legacy_experiment_uq").on(
      t.legacyExperimentId,
    ),
    statusCheck: check(
      "evaluation_studies_status_check",
      sql`${t.status} in ('draft', 'open', 'decided', 'archived')`,
    ),
  }),
);

export const evaluationRecipes = pgTable(
  "evaluation_recipes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    // Immutable recipe definition. M46 carries legacy variant configs; the fully
    // typed controlled recipe (slot bindings, execution policy) is M47 (ADR-143).
    // Never rewritten after first launch — tombstone + add instead.
    definition: jsonb("definition")
      .$type<EvaluationRecipeDefinition>()
      .notNull(),
    definitionDigest: text("definition_digest").notNull(),
    replicateGroup: text("replicate_group"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    tombstonedAt: timestamp("tombstoned_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    uniqStudyKey: unique("evaluation_recipes_study_key_uq").on(
      t.studyId,
      t.key,
    ),
    idxStudy: index("evaluation_recipes_study_idx").on(t.studyId),
  }),
);

export const evaluationParticipants = pgTable(
  "evaluation_participants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    // SET NULL: a participant survives Run deletion via its copied
    // `run_identity` snapshot; the live link just becomes unavailable (D3).
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    sourceType: text("source_type", {
      enum: ["observed", "launched"],
    }).notNull(),
    // Only set for launched participants (the owning recipe lineage).
    recipeId: text("recipe_id").references(() => evaluationRecipes.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    replicateGroup: text("replicate_group"),
    replicateOrdinal: integer("replicate_ordinal"),
    launchReason: text("launch_reason", {
      enum: ["initial", "manual_relaunch", "replicate"],
    }),
    // Crash-safe adoption anchor for controlled launches: the owning batch
    // item. The partial unique below makes participant creation convergent —
    // a re-driven item adopts its existing participant, never duplicates it.
    batchItemId: text("batch_item_id").references(
      (): AnyPgColumn => {
        return evaluationLaunchBatchItems.id;
      },
      { onDelete: "set null" },
    ),
    // Copied provenance so history survives Run deletion. Bounded, opaque —
    // never a private path, session id, adapter env, or credential.
    runIdentity: jsonb("run_identity").$type<EvaluationRunIdentitySnapshot>(),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    frozenAt: timestamp("frozen_at", { withTimezone: true, mode: "date" }),
    // Tombstone: once referenced by a sealed evidence snapshot, removal keeps
    // the row for queryable history (D3).
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxStudy: index("evaluation_participants_study_idx").on(t.studyId),
    idxRun: index("evaluation_participants_run_idx").on(t.runId),
    // One live participant per (study, run): partial UNIQUE excludes tombstones
    // so a removed Run can be re-added as a fresh participant.
    uniqLiveStudyRun: uniqueIndex("evaluation_participants_live_run_uq")
      .on(t.studyId, t.runId)
      .where(sql`${t.runId} is not null and ${t.removedAt} is null`),
    // One participant per launch-batch item (crash-safe adoption target).
    uniqBatchItem: uniqueIndex("evaluation_participants_batch_item_uq")
      .on(t.batchItemId)
      .where(sql`${t.batchItemId} is not null`),
    sourceTypeCheck: check(
      "evaluation_participants_source_type_check",
      sql`${t.sourceType} in ('observed', 'launched')`,
    ),
    // Observed participants never carry a recipe/launch lineage; launched ones
    // must (the owning recipe is set at launch).
    observedNoRecipeCheck: check(
      "evaluation_participants_observed_no_recipe_check",
      sql`(${t.sourceType} = 'launched') or (${t.recipeId} is null and ${t.launchReason} is null and ${t.replicateOrdinal} is null)`,
    ),
    replicatePositiveCheck: check(
      "evaluation_participants_replicate_positive_check",
      sql`${t.replicateOrdinal} is null or ${t.replicateOrdinal} >= 1`,
    ),
  }),
);

// --- Evaluation platform configuration (M46, ADR-143/145; 0108) ------------
// Immutable package-derived Method revisions + mutable admin Panels/Profiles
// and project overrides (D6, D8). Package content NEVER contains credentials,
// concrete runner ids, host model ids, or executable scripts (D7); portable
// method definitions resolve checks/aggregators only through closed registries.

// A package install's projected Evaluation Method revision. The immutable
// version is the containing install's versionLabel + resolvedRevision/digests —
// there is deliberately NO method-local version field (D6, avoids skew).
export const evaluationMethodRevisions = pgTable(
  "evaluation_method_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // RESTRICT: a package install cannot be deleted while a projected method
    // revision references it (usage-guarded, D6). Detach happens first.
    packageInstallId: text("package_install_id")
      .notNull()
      .references(() => packageInstalls.id, { onDelete: "restrict" }),
    // The method id within the package (e.g. "sdd-quality").
    methodId: text("method_id").notNull(),
    // `<packageName>:<methodId>` (D6).
    qualifiedId: text("qualified_id").notNull(),
    // Denormalized for the Methodologies list (package/version/SHA display).
    packageName: text("package_name").notNull(),
    versionLabel: text("version_label").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    // The normalized method definition (opaque, closed-registry refs only).
    normalizedDefinition: jsonb("normalized_definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    definitionDigest: text("definition_digest").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    compat: jsonb("compat").$type<EvaluationMethodCompat>().notNull(),
    // Mutable activation state; health (ready|degraded|incompatible) is derived.
    activation: text("activation", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("disabled"),
    // Non-empty only for a projection that failed strict validation; such a
    // revision is never selectable.
    validationErrors: jsonb("validation_errors").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqInstallMethod: unique(
      "evaluation_method_revisions_install_method_uq",
    ).on(t.packageInstallId, t.methodId),
    idxQualified: index("evaluation_method_revisions_qualified_idx").on(
      t.qualifiedId,
    ),
    activationCheck: check(
      "evaluation_method_revisions_activation_check",
      sql`${t.activation} in ('enabled', 'disabled')`,
    ),
  }),
);

// Mutable admin Judge Panel with optimistic revision. Maps logical roles to
// package-qualified platform agents ONLY in M46 (D8); project-linked bindings
// are deferred. Historical executions snapshot the effective panel at start, so
// editing a panel never mutates an in-flight or completed execution.
export const evaluationJudgePanels = pgTable(
  "evaluation_judge_panels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    // Optimistic-concurrency guard; PATCH/DELETE require If-Match.
    revision: integer("revision").notNull().default(1),
    roleBindings: jsonb("role_bindings")
      .$type<EvaluationPanelRoleBinding[]>()
      .notNull(),
    policy: jsonb("policy").$type<EvaluationPanelPolicy>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
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
    idxEnabled: index("evaluation_judge_panels_enabled_idx").on(t.enabled),
  }),
);

// Mutable admin Evaluation Profile: one Method revision + one Panel + defaults,
// hard limits, and an explicit allow-list of project/study overrides (D8).
export const evaluationProfiles = pgTable(
  "evaluation_profiles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    // RESTRICT on both refs — the Profile is usage that guards deletion of a
    // Method revision / Panel; historical executions use snapshots (D8).
    methodRevisionId: text("method_revision_id")
      .notNull()
      .references(() => evaluationMethodRevisions.id, { onDelete: "restrict" }),
    panelId: text("panel_id")
      .notNull()
      .references(() => evaluationJudgePanels.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull().default(1),
    defaults: jsonb("defaults").$type<Record<string, unknown>>(),
    hardLimits: jsonb("hard_limits").$type<Record<string, unknown>>(),
    // Which fields a project/study may override, and the bounds on each.
    allowedOverrides:
      jsonb("allowed_overrides").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
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
    idxMethod: index("evaluation_profiles_method_idx").on(t.methodRevisionId),
    idxPanel: index("evaluation_profiles_panel_idx").on(t.panelId),
  }),
);

// Optional per-project saved override values, constrained to the Profile's
// allowed-override allow-list. SET/CLEAR/re-set symmetry is service-enforced.
export const evaluationProjectProfileOverrides = pgTable(
  "evaluation_project_profile_overrides",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // RESTRICT: an override counts as usage guarding Profile deletion (D8).
    profileId: text("profile_id")
      .notNull()
      .references(() => evaluationProfiles.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull().default(1),
    overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
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
    uniqProjectProfile: unique(
      "evaluation_project_profile_overrides_project_profile_uq",
    ).on(t.projectId, t.profileId),
  }),
);

// --- Evaluation execution + immutable evidence (M46, ADR-144/145; 0109) -----
// The runtime record of an Evaluation Execution over a sealed evidence
// snapshot, its objective checks/metrics, multi-judge attempts, aggregation,
// disagreement reviews, human verdicts, and the replayable Study event log.
// Evidence payloads live on the host content-addressed store (D9); only bounded
// metadata is normalized here. No client-visible column carries a private path,
// session id, adapter env, credential, or evidence/rationale body.

// An immutable evidence snapshot (D5, D9). A `sealed` snapshot may be attached
// to multiple executions when participant-set + evidence-protocol digests
// match; later Run progress never mutates it — a new execution captures later
// state. Deletion is two-stage (pending_delete → deleted) and reference-guarded.
export const evaluationEvidenceSnapshots = pgTable(
  "evaluation_evidence_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["preparing", "sealed", "pending_delete", "deleted"],
    })
      .notNull()
      .default("preparing"),
    // The frozen participant id list + each participant's resolved Run/event
    // watermark (branch tip SHA + append-only log offset) at capture time.
    participantWatermarks: jsonb("participant_watermarks")
      .$type<Record<string, unknown>>()
      .notNull(),
    // Digest of the method/profile evidence protocol this snapshot satisfies —
    // an execution may attach only when its protocol digest matches (D5).
    evidenceProtocolDigest: text("evidence_protocol_digest").notNull(),
    // Digest over the sealed manifest (all item rows); the attach/reuse key.
    manifestDigest: text("manifest_digest"),
    coverageSummary: jsonb("coverage_summary").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<string[]>(),
    // Host content-store generation (root rotation marker) for GC.
    storageGeneration: text("storage_generation"),
    sealedAt: timestamp("sealed_at", { withTimezone: true, mode: "date" }),
    preparedByUserId: text("prepared_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    pendingDeleteAt: timestamp("pending_delete_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxStudy: index("evaluation_evidence_snapshots_study_idx").on(t.studyId),
    // Sealed snapshots with the same participant-set + protocol digest are
    // reusable; the digest index backs the attach lookup.
    idxProtocolDigest: index(
      "evaluation_evidence_snapshots_protocol_digest_idx",
    ).on(t.evidenceProtocolDigest),
    statusCheck: check(
      "evaluation_evidence_snapshots_status_check",
      sql`${t.status} in ('preparing', 'sealed', 'pending_delete', 'deleted')`,
    ),
  }),
);

// One bounded evidence item in a snapshot manifest (D9). Public DTOs expose the
// opaque id + logical label only — never `locator` (a logical path) as a real
// filesystem path, and never the payload (which lives on the content store).
export const evaluationEvidenceItems = pgTable(
  "evaluation_evidence_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => evaluationEvidenceSnapshots.id, {
        onDelete: "cascade",
      }),
    // Nullable for items shared across participants (e.g. the task/ground-truth).
    participantId: text("participant_id").references(
      () => evaluationParticipants.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(),
    // Logical locator (opaque label), NOT a host filesystem path.
    locator: text("locator").notNull(),
    digest: text("digest").notNull(),
    bytes: integer("bytes"),
    coverageClass: text("coverage_class").notNull(),
    inclusionReason: text("inclusion_reason"),
    truncation: jsonb("truncation").$type<Record<string, unknown>>(),
    redaction: jsonb("redaction").$type<Record<string, unknown>>(),
    // Content-store key for the immutable payload (server-only; never in a DTO).
    blobKey: text("blob_key"),
    retention: text("retention"),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }),
    sourceWatermark: text("source_watermark"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxSnapshot: index("evaluation_evidence_items_snapshot_idx").on(
      t.snapshotId,
    ),
    idxParticipant: index("evaluation_evidence_items_participant_idx").on(
      t.participantId,
    ),
  }),
);

// The append-only identity of one Evaluation Execution (D4, D5). State
// transitions are CAS/version-guarded; retry never re-enters a terminal row
// (a new execution with `retry_of` starts at queued). `evidence_snapshot_id`
// is required before Checking.
export const evaluationExecutions = pgTable(
  "evaluation_executions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    // RESTRICT: method revision usage guard (historical executions snapshot the
    // effective profile, but the revision row itself stays referenceable).
    // Nullable ONLY to represent legacy synthesized executions honestly — the
    // old hardcoded judge had no package method (never fabricate one). The
    // service REQUIRES a method revision for every new (non-legacy) execution.
    methodRevisionId: text("method_revision_id").references(
      () => evaluationMethodRevisions.id,
      { onDelete: "restrict" },
    ),
    // Nullable until sealed; RESTRICT so a sealed snapshot citing this execution
    // cannot be hard-deleted (deletion is reference-guarded, D5).
    evidenceSnapshotId: text("evidence_snapshot_id").references(
      () => evaluationEvidenceSnapshots.id,
      { onDelete: "restrict" },
    ),
    status: text("status", {
      enum: [
        "queued",
        "capturing",
        "checking",
        "judging",
        "aggregating",
        "review_required",
        "cancelling",
        "completed",
        "partial",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    version: integer("version").notNull().default(1),
    // The complete resolved effective profile snapshotted at start (D8): method
    // hard constraints, profile bounds, panel binding, project/study overrides,
    // resolved agents/runners/models, MCP allow-list, prompt/schema digests.
    effectiveProfileSnapshot: jsonb("effective_profile_snapshot").$type<
      Record<string, unknown>
    >(),
    randomizationSeed: text("randomization_seed"),
    objectivePolicySnapshot: jsonb("objective_policy_snapshot").$type<
      Record<string, unknown>
    >(),
    judgePolicySnapshot: jsonb("judge_policy_snapshot").$type<
      Record<string, unknown>
    >(),
    aggregationPolicySnapshot: jsonb("aggregation_policy_snapshot").$type<
      Record<string, unknown>
    >(),
    idempotencyKey: text("idempotency_key"),
    // Digest of the semantic request (profile + overrides). Same key + same
    // digest replays the original execution; same key + different digest is a
    // CONFLICT — a reused key never silently returns a different request's row.
    requestDigest: text("request_digest"),
    // Terminal/failure reason (typed code), never a private body.
    terminalReason: text("terminal_reason"),
    retryOf: text("retry_of").references(
      (): AnyPgColumn => {
        return evaluationExecutions.id;
      },
      { onDelete: "set null" },
    ),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", {
      withTimezone: true,
      mode: "date",
    }),
    terminalAt: timestamp("terminal_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxStudyStatus: index("evaluation_executions_study_status_idx").on(
      t.studyId,
      t.status,
    ),
    // Same idempotency key within a Study returns the original execution.
    uniqStudyIdem: uniqueIndex("evaluation_executions_study_idem_uq")
      .on(t.studyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    statusCheck: check(
      "evaluation_executions_status_check",
      sql`${t.status} in ('queued', 'capturing', 'checking', 'judging', 'aggregating', 'review_required', 'cancelling', 'completed', 'partial', 'failed', 'cancelled')`,
    ),
  }),
);

// One objective check attempt over a participant in an execution (D11). No PASS
// without an executed/recorded fact; nonterminal/absence statuses need a reason.
export const evaluationObjectiveCheckRuns = pgTable(
  "evaluation_objective_check_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => evaluationExecutions.id, { onDelete: "cascade" }),
    participantId: text("participant_id").references(
      () => evaluationParticipants.id,
      { onDelete: "set null" },
    ),
    checkId: text("check_id").notNull(),
    checkVersion: text("check_version").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "passed",
        "failed",
        "error",
        "cancelled",
        "not_run",
        "unavailable",
      ],
    })
      .notNull()
      .default("queued"),
    reason: text("reason"),
    inputDigest: text("input_digest"),
    outputDigest: text("output_digest"),
    // Which trusted host check profile executed this (platform-owned), if any.
    trustedProfileProvenance: jsonb("trusted_profile_provenance").$type<
      Record<string, unknown>
    >(),
    logEvidenceItemId: text("log_evidence_item_id").references(
      () => evaluationEvidenceItems.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqExecParticipantCheckAttempt: unique(
      "evaluation_objective_check_runs_unique",
    ).on(t.executionId, t.participantId, t.checkId, t.attempt),
    idxExecution: index("evaluation_objective_check_runs_execution_idx").on(
      t.executionId,
    ),
    statusCheck: check(
      "evaluation_objective_check_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'passed', 'failed', 'error', 'cancelled', 'not_run', 'unavailable')`,
    ),
  }),
);

// A normalized objective metric per participant/execution (D11, D18). Missing
// is explicit with a reason; never converted to numeric zero.
export const evaluationMetricResults = pgTable(
  "evaluation_metric_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => evaluationExecutions.id, { onDelete: "cascade" }),
    participantId: text("participant_id").references(
      () => evaluationParticipants.id,
      { onDelete: "set null" },
    ),
    metricId: text("metric_id").notNull(),
    metricVersion: text("metric_version").notNull(),
    status: text("status", {
      enum: ["measured", "unavailable", "not_run"],
    }).notNull(),
    reason: text("reason"),
    value: jsonb("value").$type<Record<string, unknown>>(),
    unit: text("unit"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxExecution: index("evaluation_metric_results_execution_idx").on(
      t.executionId,
    ),
    statusCheck: check(
      "evaluation_metric_results_status_check",
      sql`${t.status} in ('measured', 'unavailable', 'not_run')`,
    ),
  }),
);

// One independent judge attempt (D12). Each attempt is a separate agent Run
// with a dedicated attempt-bound token; results are sealed from peers until
// quorum/terminal. All attribution is server-derived at launch/seal.
export const evaluationJudgeAttempts = pgTable(
  "evaluation_judge_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => evaluationExecutions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    ordinal: integer("ordinal").notNull(),
    // 0 for a primary attempt; > 0 for a bounded repair child (retry_of set).
    retryOrdinal: integer("retry_ordinal").notNull().default(0),
    // ADR-150 (pairwise): the unordered participant PAIR this attempt judges.
    // NULL for every non-pairwise attempt. Part of the unique key with
    // NULLS NOT DISTINCT so non-pairwise dedup survives the widening.
    matchA: text("match_a"),
    matchB: text("match_b"),
    retryOf: text("retry_of").references(
      (): AnyPgColumn => {
        return evaluationJudgeAttempts.id;
      },
      { onDelete: "set null" },
    ),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    agentRevision: text("agent_revision"),
    agentRunId: text("agent_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    // Crash-safe launch intent: the pre-generated run id recorded BEFORE the
    // spawn side effect. On recovery, a queued attempt with an intent either
    // adopts the run (if the crashed spawn created it) or re-spawns with the
    // SAME id — never a duplicate Run. No FK: the run may not exist yet.
    intendedRunId: text("intended_run_id"),
    // Ephemeral attempt-bound token id (revoked at terminal); opaque, no FK to
    // keep the token lifecycle independent of this ledger.
    tokenId: text("token_id"),
    runnerSnapshot: jsonb("runner_snapshot").$type<Record<string, unknown>>(),
    modelSnapshot: jsonb("model_snapshot").$type<Record<string, unknown>>(),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "completed",
        "invalid",
        "timed_out",
        "cancelled",
        "error",
      ],
    })
      .notNull()
      .default("queued"),
    reason: text("reason"),
    // The sealed strict result body (member-visible via DTO; never streamed).
    sealedResult: jsonb("sealed_result").$type<Record<string, unknown>>(),
    resultDigest: text("result_digest"),
    promptDigest: text("prompt_digest"),
    schemaDigest: text("schema_digest"),
    evidenceDigest: text("evidence_digest"),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    cost: jsonb("cost").$type<Record<string, unknown>>(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true, mode: "date" }),
    // Timeout clock anchors here (session Running), never at enqueue (D12).
    runningAt: timestamp("running_at", { withTimezone: true, mode: "date" }),
    terminalAt: timestamp("terminal_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqExecRoleOrdinal: unique("evaluation_judge_attempts_unique")
      .on(t.executionId, t.role, t.ordinal, t.retryOrdinal, t.matchA, t.matchB)
      // NULLS NOT DISTINCT: non-pairwise attempts carry NULL match columns;
      // without this Postgres treats each NULL pair as distinct and the widened
      // key would stop deduping them (ADR-150).
      .nullsNotDistinct(),
    idxExecution: index("evaluation_judge_attempts_execution_idx").on(
      t.executionId,
    ),
    statusCheck: check(
      "evaluation_judge_attempts_status_check",
      sql`${t.status} in ('queued', 'running', 'completed', 'invalid', 'timed_out', 'cancelled', 'error')`,
    ),
  }),
);

// One per-criterion result inside a sealed judge attempt (D12). A null score
// pairs with insufficient_evidence | not_applicable — missing never becomes 0.
export const evaluationCriterionResults = pgTable(
  "evaluation_criterion_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => evaluationJudgeAttempts.id, { onDelete: "cascade" }),
    participantId: text("participant_id").references(
      () => evaluationParticipants.id,
      { onDelete: "set null" },
    ),
    criterionId: text("criterion_id").notNull(),
    state: text("state", {
      enum: ["scored", "insufficient_evidence", "not_applicable"],
    }).notNull(),
    score: numeric("score"),
    rationale: text("rationale"),
    confidence: numeric("confidence"),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>(),
    objectiveRefs: jsonb("objective_refs").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One row per (attempt, criterion, participant). NULLS NOT DISTINCT so the
    // holistic case (participant_id null) is also single-writer — a duplicate
    // seal can never double-write a criterion cell (belt; the seal CAS is the
    // suspenders).
    uniqAttemptCriterionParticipant: unique(
      "evaluation_criterion_results_attempt_criterion_uq",
    )
      .on(t.attemptId, t.criterionId, t.participantId)
      .nullsNotDistinct(),
    idxAttempt: index("evaluation_criterion_results_attempt_idx").on(
      t.attemptId,
    ),
    stateCheck: check(
      "evaluation_criterion_results_state_check",
      sql`${t.state} in ('scored', 'insufficient_evidence', 'not_applicable')`,
    ),
    // scored ⇒ numeric score present; non-scored ⇒ score is null (D12).
    scoreStateCheck: check(
      "evaluation_criterion_results_score_state_check",
      sql`(${t.state} = 'scored' and ${t.score} is not null) or (${t.state} <> 'scored' and ${t.score} is null)`,
    ),
  }),
);

// The single deterministic aggregate for one execution (D13). Persists exact
// included attempt ids, unrounded calculations, display rounding, exclusions,
// caps, quorum, dispersion, and digests; never overwrites raw attempts.
export const evaluationAggregateResults = pgTable(
  "evaluation_aggregate_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => evaluationExecutions.id, { onDelete: "cascade" }),
    algorithmId: text("algorithm_id").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    calculations: jsonb("calculations")
      .$type<Record<string, unknown>>()
      .notNull(),
    displayValues: jsonb("display_values").$type<Record<string, unknown>>(),
    caps: jsonb("caps").$type<Record<string, unknown>>(),
    quorum: jsonb("quorum").$type<Record<string, unknown>>(),
    exclusions: jsonb("exclusions").$type<Record<string, unknown>>(),
    dispersion: jsonb("dispersion").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<string[]>(),
    digest: text("digest").notNull(),
    // Append-only: a review adjudication writes a new revision, never a rewrite.
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Append-only revisions are strictly sequential per execution; concurrent
    // persists race on this unique and the loser re-reads + retries (persist.ts).
    uniqExecutionRevision: unique(
      "evaluation_aggregate_results_execution_revision_uq",
    ).on(t.executionId, t.revision),
    idxExecution: index("evaluation_aggregate_results_execution_idx").on(
      t.executionId,
    ),
  }),
);

// Durable disagreement/escalation review ledger (D13).
export const evaluationReviews = pgTable(
  "evaluation_reviews",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => evaluationExecutions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["disagreement", "escalation"] }).notNull(),
    status: text("status", { enum: ["required", "resolved"] })
      .notNull()
      .default("required"),
    version: integer("version").notNull().default(1),
    flags: jsonb("flags").$type<Record<string, unknown>>(),
    reviewerUserId: text("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolution: text("resolution"),
    rationale: text("rationale"),
    adjudicatedResult:
      jsonb("adjudicated_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    idxExecution: index("evaluation_reviews_execution_idx").on(t.executionId),
    kindCheck: check(
      "evaluation_reviews_kind_check",
      sql`${t.kind} in ('disagreement', 'escalation')`,
    ),
    statusCheck: check(
      "evaluation_reviews_status_check",
      sql`${t.status} in ('required', 'resolved')`,
    ),
  }),
);

// Append-only, human-auth-only conclusive verdict (D14). A verdict may cite zero
// executions only with an explicit no-evaluation-evidence acknowledgement. A
// correction is a superseding row; judge code can never write one.
export const evaluationHumanVerdicts = pgTable(
  "evaluation_human_verdicts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    supersedesId: text("supersedes_id").references(
      (): AnyPgColumn => {
        return evaluationHumanVerdicts.id;
      },
      { onDelete: "set null" },
    ),
    outcome: text("outcome", {
      enum: ["winner", "tie", "inconclusive"],
    }).notNull(),
    participantIds: jsonb("participant_ids").$type<string[]>().notNull(),
    executionIds: jsonb("execution_ids").$type<string[]>().notNull(),
    noEvaluationEvidenceAck: boolean("no_evaluation_evidence_ack")
      .notNull()
      .default(false),
    rationale: text("rationale"),
    acknowledgedWarnings: jsonb("acknowledged_warnings").$type<string[]>(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxStudy: index("evaluation_human_verdicts_study_idx").on(t.studyId),
    outcomeCheck: check(
      "evaluation_human_verdicts_outcome_check",
      sql`${t.outcome} in ('winner', 'tie', 'inconclusive')`,
    ),
    // Zero-citation verdict requires the explicit acknowledgement (D14).
    zeroCitationAckCheck: check(
      "evaluation_human_verdicts_zero_citation_check",
      sql`jsonb_array_length(${t.executionIds}) > 0 or ${t.noEvaluationEvidenceAck} = true`,
    ),
  }),
);

// The replayable per-Study event log backing Study SSE (D17). Payloads carry
// bounded ids/status/counts only — never evidence or rationale bodies.
export const evaluationEvents = pgTable(
  "evaluation_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    executionId: text("execution_id").references(
      () => evaluationExecutions.id,
      { onDelete: "set null" },
    ),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqStudySequence: unique("evaluation_events_study_sequence_uq").on(
      t.studyId,
      t.sequence,
    ),
    idxStudy: index("evaluation_events_study_idx").on(t.studyId),
  }),
);

// M47 (ADR-143 D17): a durable controlled-launch batch intent. Persisted BEFORE
// any run-launch side effect so a crash mid-fan-out leaves a recoverable intent,
// never a silent partial batch. An immediate in-process kick drives it; the
// scheduler is the durable backstop (same handler). Idempotency-keyed so a
// duplicate submit (double click) returns the original batch, never a second.
export const evaluationLaunchBatches = pgTable(
  "evaluation_launch_batches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "launching", "completed", "partial", "failed"],
    })
      .notNull()
      .default("queued"),
    idempotencyKey: text("idempotency_key"),
    // Digest of the semantic request (items). Same key + same digest replays
    // the original batch; same key + different digest is a CONFLICT.
    requestDigest: text("request_digest"),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // CAS guard for batch-level status transitions.
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    idxStudy: index("evaluation_launch_batches_study_idx").on(t.studyId),
    // Same idempotency key within a Study returns the original batch (scoped
    // like evaluation_executions — a key reused in another Study is unrelated).
    uniqStudyIdem: uniqueIndex("evaluation_launch_batches_study_idem_uq")
      .on(t.studyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    statusCheck: check(
      "evaluation_launch_batches_status_check",
      sql`${t.status} in ('queued', 'launching', 'completed', 'partial', 'failed')`,
    ),
  }),
);

// M47 (ADR-143 D17): one durable item per (recipe × replicate) in a batch. Its
// per-item status FSM (queued → launching → launched | failed) with a CAS
// `version` is the crash-recovery unit: a launched item records its owning
// run + launched participant; a failed item records the reason and a bounded
// attempt count for retry/adopt.
export const evaluationLaunchBatchItems = pgTable(
  "evaluation_launch_batch_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    batchId: text("batch_id")
      .notNull()
      .references(() => evaluationLaunchBatches.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => evaluationRecipes.id, { onDelete: "restrict" }),
    replicateOrdinal: integer("replicate_ordinal").notNull(),
    status: text("status", {
      enum: ["queued", "launching", "launched", "failed"],
    })
      .notNull()
      .default("queued"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    participantId: text("participant_id").references(
      () => evaluationParticipants.id,
      { onDelete: "set null" },
    ),
    attempt: integer("attempt").notNull().default(0),
    errorReason: text("error_reason"),
    // CAS guard: queued → launching is the claim; launching → launched|failed is
    // the terminal write. A stale version loses the race (idempotent no-op).
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxBatch: index("evaluation_launch_batch_items_batch_idx").on(t.batchId),
    idxStatus: index("evaluation_launch_batch_items_status_idx").on(t.status),
    // One item per (batch, recipe, replicate) — the durable dedup unit.
    uniqItem: unique("evaluation_launch_batch_items_item_uq").on(
      t.batchId,
      t.recipeId,
      t.replicateOrdinal,
    ),
    statusCheck: check(
      "evaluation_launch_batch_items_status_check",
      sql`${t.status} in ('queued', 'launching', 'launched', 'failed')`,
    ),
    replicatePositiveCheck: check(
      "evaluation_launch_batch_items_replicate_positive_check",
      sql`${t.replicateOrdinal} >= 1`,
    ),
  }),
);

// M48 (ADR-147 T7.2): a versioned Evaluation Suite — the benchmark/regression
// PARENT that sits OUTSIDE the one-task Study boundary. It names a task set +
// profile; each scheduled scan generates ONE one-task Study per task (every
// generated Study stays one project/task, D2). A `regression` suite is triggered
// by a package-revision change; a `scheduled` suite by its cadence. The M24
// scheduler drives it — no second clock.
export const evaluationSuites = pgTable(
  "evaluation_suites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["scheduled", "regression"] })
      .notNull()
      .default("scheduled"),
    // Immutable-per-version definition: { taskIds, profileId, trigger? }. Bumped
    // (version+1) on any edit so longitudinal metrics can attribute drift to a
    // definition revision (calibration/drift versioning).
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    definitionDigest: text("definition_digest").notNull(),
    version: integer("version").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    // For a `regression` suite: the package revision last scanned, so a scan only
    // fires when the revision actually changed (package-revision-change trigger).
    lastTriggerRevision: text("last_trigger_revision"),
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
    idxProject: index("evaluation_suites_project_idx").on(t.projectId),
    kindCheck: check(
      "evaluation_suites_kind_check",
      sql`${t.kind} in ('scheduled', 'regression')`,
    ),
  }),
);

// M48 (ADR-144 T7.2): the immutable link from a suite scan round to the one-task
// Study it generated. The (suite, task, scan_key) UNIQUE is the capped-scan dedup
// unit — a re-scan of the same round never generates a duplicate Study (poison-
// suite / at-least-once safe).
export const evaluationSuiteStudies = pgTable(
  "evaluation_suite_studies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    suiteId: text("suite_id")
      .notNull()
      .references(() => evaluationSuites.id, { onDelete: "cascade" }),
    studyId: text("study_id")
      .notNull()
      .references(() => evaluationStudies.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    // The suite definition version this Study was generated under (drift attrib).
    suiteVersion: integer("suite_version").notNull(),
    // Deterministic scan-round key (e.g. `${suiteVersion}:${triggerRevision}`) —
    // the idempotency unit for a capped scan.
    scanKey: text("scan_key").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxSuite: index("evaluation_suite_studies_suite_idx").on(t.suiteId),
    uniqScan: unique("evaluation_suite_studies_scan_uq").on(
      t.suiteId,
      t.taskId,
      t.scanKey,
    ),
  }),
);

// M48 (ADR-144 T7.3): the append-only audit ledger of human-approved recipe
// standardizations. NOT automatic Run promotion — a project admin copies a
// winning immutable recipe into a project-default slot ONLY after a conclusive
// human verdict + a fresh compatibility/trust preflight. Each row is a revision
// (standardize or rollback); the CURRENT project default is the highest revision
// for a slot. Rollback appends a revision restoring a prior definition — the two-
// phase/supersede/rollback contract, fully audited (source study/recipe/verdict).
export const evaluationStandardizedRecipes = pgTable(
  "evaluation_standardized_recipes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The project-default slot this revision targets (default `default`).
    slot: text("slot").notNull().default("default"),
    revision: integer("revision").notNull(),
    action: text("action", { enum: ["standardize", "rollback"] }).notNull(),
    // Provenance of the standardized recipe (nullable so history survives source
    // deletion; the copied definition below is self-contained).
    sourceStudyId: text("source_study_id").references(
      () => evaluationStudies.id,
      { onDelete: "set null" },
    ),
    sourceRecipeId: text("source_recipe_id").references(
      () => evaluationRecipes.id,
      { onDelete: "set null" },
    ),
    sourceVerdictId: text("source_verdict_id").references(
      () => evaluationHumanVerdicts.id,
      { onDelete: "set null" },
    ),
    // The copied immutable recipe definition + digest (self-contained snapshot).
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    definitionDigest: text("definition_digest").notNull(),
    // For a `rollback` action: the revision whose definition was restored.
    rolledBackToRevision: integer("rolled_back_to_revision"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProjectSlot: index(
      "evaluation_standardized_recipes_project_slot_idx",
    ).on(t.projectId, t.slot),
    uniqRevision: unique("evaluation_standardized_recipes_revision_uq").on(
      t.projectId,
      t.slot,
      t.revision,
    ),
    actionCheck: check(
      "evaluation_standardized_recipes_action_check",
      sql`${t.action} in ('standardize', 'rollback')`,
    ),
  }),
);

// M42 (ADR-114): per-(run, session) runner state — the SOLE source of truth for
// a run's runner(s). One row per logical session (`default` / solo / named) for a
// flow run; exactly one `default` row for a scratch/agent run. The run-level
// runner columns (runs.{runner_id, runner_resolution_tier, capability_agent,
// runner_snapshot, acp_session_id}) were dropped in the M42 contract migration
// after every reader moved to this table.
export const runSessions = pgTable(
  "run_sessions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sessionName: text("session_name").notNull(),
    runnerId: text("runner_id").references(() => platformAcpRunners.id, {
      onDelete: "set null",
    }),
    runnerResolutionTier: text("runner_resolution_tier", {
      enum: [
        "launchOverride",
        "stepTarget",
        // M42 (ADR-114) per-slot binding + unique host auto-match tiers.
        "binding",
        "autoMatch",
        "projectFlowDefault",
        "platformFlowDefault",
        "projectDefault",
        "platformDefault",
        // M34 (ADR-089) standalone agent chain tiers.
        "agentLinkOverride",
        "agentDefault",
        // ADR-141: branch-sync AI-resolver default (projects.sync_runner_id).
        "syncDefault",
      ],
    }),
    capabilityAgent: text("capability_agent", { enum: ADAPTER_IDS }),
    runnerSnapshot: jsonb("runner_snapshot").$type<RunnerSnapshot>(),
    acpSessionId: text("acp_session_id"),
    // Audit descriptor of the concrete source that resolved this session's
    // runner (the slot_key for a binding/auto-match, the chain scope for the
    // default chain, or "launch-dialog" for an ephemeral per-run override).
    resolutionSource: text("resolution_source"),
    resolutionWarning: jsonb(
      "resolution_warning",
    ).$type<RunnerResolutionWarning | null>(),
    // ADR-166 (migration 0130): which assignment epoch spawned this session's
    // current process (updated per spawn), and the SUPERVISOR session id —
    // written by the session.create acknowledgement, so it is present from
    // spawn, unlike acp_session_id which lands only after the first prompt.
    executionAssignmentId: text("execution_assignment_id").references(
      () => executionAssignments.id,
      { onDelete: "set null" },
    ),
    hostSessionId: text("host_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRunSession: unique("run_sessions_run_session_uq").on(
      t.runId,
      t.sessionName,
    ),
    idxRunner: index("run_sessions_runner_idx").on(t.runnerId),
    idxHostSession: index("run_sessions_host_session_idx").on(t.hostSessionId),
    idxAssignment: index("run_sessions_assignment_idx").on(
      t.executionAssignmentId,
    ),
  }),
);

export type RunSession = typeof runSessions.$inferSelect;

// ADR-167 canonical execution event plane. These tables deliberately do not
// reuse domain_events: host stream order and acknowledgement retention are a
// separate protocol concern.
export const executionEventStreams = pgTable(
  "execution_event_streams",
  {
    id: text("id").primaryKey(),
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    streamId: text("stream_id").notNull(),
    state: text("state", { enum: ["observed", "active", "closed", "lost"] })
      .notNull()
      .default("observed"),
    lastReceivedSequence: bigint("last_received_sequence", { mode: "bigint" }),
    lastContiguousSequence: bigint("last_contiguous_sequence", {
      mode: "bigint",
    }),
    lastAckConfirmedSequence: bigint("last_ack_confirmed_sequence", {
      mode: "bigint",
    }),
    replayFloorSequence: bigint("replay_floor_sequence", { mode: "bigint" }),
    lastBootId: text("last_boot_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    firstGapSequence: bigint("first_gap_sequence", { mode: "bigint" }),
    gapDetectedAt: timestamp("gap_detected_at", {
      withTimezone: true,
      mode: "date",
    }),
    gapStatus: text("gap_status", { enum: ["open", "unrecoverable"] }),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    nextRetryAt: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "date",
    }),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    uniqHostStream: unique("execution_event_streams_host_stream_uq").on(
      t.executionHostId,
      t.streamId,
    ),
    uniqActiveHost: uniqueIndex("execution_event_streams_active_host_uq")
      .on(t.executionHostId)
      .where(sql`${t.state} = 'active'`),
    idxRetry: index("execution_event_streams_retry_idx").on(
      t.nextRetryAt,
      t.claimExpiresAt,
    ),
  }),
);

export const runSessionIncarnations = pgTable(
  "run_session_incarnations",
  {
    id: text("id").primaryKey(),
    runSessionId: text("run_session_id")
      .notNull()
      .references(() => runSessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionAssignmentId: text("execution_assignment_id").references(
      () => executionAssignments.id,
      { onDelete: "set null" },
    ),
    assignmentEpoch: integer("assignment_epoch"),
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    hostSessionId: text("host_session_id").notNull(),
    hostBootId: text("host_boot_id"),
    acpSessionId: text("acp_session_id"),
    state: text("state", {
      enum: [
        "created",
        "active",
        "checkpointed",
        "exited",
        "crashed",
        "lost",
        "deleted",
      ],
    }).notNull(),
    origin: text("origin", { enum: ["native", "legacy_backfill"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    terminalReason: jsonb("terminal_reason").$type<Record<string, unknown>>(),
  },
  (t) => ({
    uniqHostSession: unique("run_session_incarnations_host_session_uq").on(
      t.executionHostId,
      t.hostSessionId,
    ),
    uniqActiveRunSession: uniqueIndex(
      "run_session_incarnations_active_run_session_uq",
    )
      .on(t.runSessionId)
      .where(sql`${t.state} IN ('created', 'active', 'checkpointed')`),
  }),
);

export const executionEvents = pgTable(
  "execution_events",
  {
    id: text("id").primaryKey(),
    source: text("source", {
      enum: ["host", "manager", "legacy_import"],
    }).notNull(),
    sourceKey: text("source_key"),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionHostId: text("execution_host_id").references(
      () => executionHosts.id,
      { onDelete: "restrict" },
    ),
    eventStreamId: text("event_stream_id").references(
      () => executionEventStreams.id,
      { onDelete: "restrict" },
    ),
    hostSequence: bigint("host_sequence", { mode: "bigint" }),
    executionAssignmentId: text("execution_assignment_id").references(
      () => executionAssignments.id,
      { onDelete: "set null" },
    ),
    assignmentEpoch: integer("assignment_epoch"),
    runSessionIncarnationId: text("run_session_incarnation_id").references(
      () => runSessionIncarnations.id,
      { onDelete: "set null" },
    ),
    hostBootId: text("host_boot_id"),
    hostSessionId: text("host_session_id"),
    envelopeVersion: integer("envelope_version"),
    eventType: text("event_type").notNull(),
    payloadSchema: text("payload_schema").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    payloadSha256: text("payload_sha256"),
    payloadBytes: integer("payload_bytes"),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    runSequence: bigint("run_sequence", { mode: "bigint" }),
    ingestDisposition: text("ingest_disposition", {
      enum: ["pending_gap", "accepted", "stale_epoch", "quarantined"],
    }).notNull(),
    ingestError: jsonb("ingest_error").$type<Record<string, unknown>>(),
  },
  (t) => ({
    uniqHostPosition: uniqueIndex("execution_events_host_position_uq")
      .on(t.eventStreamId, t.hostSequence)
      .where(sql`${t.eventStreamId} IS NOT NULL`),
    uniqSourceKey: uniqueIndex("execution_events_source_run_key_uq")
      .on(t.source, t.runId, t.sourceKey)
      .where(sql`${t.sourceKey} IS NOT NULL`),
    uniqRunSequence: uniqueIndex("execution_events_run_sequence_uq")
      .on(t.runId, t.runSequence)
      .where(sql`${t.runSequence} IS NOT NULL`),
    idxRunSequence: index("execution_events_run_sequence_idx").on(
      t.runId,
      t.runSequence,
    ),
    sourceShapeCheck: check(
      "execution_events_source_shape_check",
      sql`(${t.source} = 'host' AND ${t.eventStreamId} IS NOT NULL AND ${t.hostSequence} IS NOT NULL) OR (${t.source} IN ('manager', 'legacy_import') AND ${t.sourceKey} IS NOT NULL AND ${t.eventStreamId} IS NULL AND ${t.hostSequence} IS NULL)`,
    ),
    protocolBoundsCheck: check(
      "execution_events_protocol_bounds_check",
      sql`(${t.hostSequence} IS NULL OR ${t.hostSequence} >= 0) AND (${t.runSequence} IS NULL OR ${t.runSequence} >= 0) AND (${t.assignmentEpoch} IS NULL OR ${t.assignmentEpoch} >= 1) AND (${t.payloadBytes} IS NULL OR ${t.payloadBytes} BETWEEN 0 AND 1048576) AND (${t.source} <> 'host' OR (${t.executionHostId} IS NOT NULL AND ${t.hostBootId} IS NOT NULL AND ${t.envelopeVersion} = 1))`,
    ),
  }),
);

// ADR-167 D8: manager-owned metadata for host-owned runtime bytes. The private
// host path exists only in supervisor SQLite; the web tier addresses content by
// this opaque ID and derives the host/run binding from this catalog.
export const executionRuntimeObjects = pgTable(
  "execution_runtime_objects",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    executionAssignmentId: text("execution_assignment_id").references(
      () => executionAssignments.id,
      { onDelete: "set null" },
    ),
    assignmentEpoch: integer("assignment_epoch"),
    runSessionIncarnationId: text("run_session_incarnation_id").references(
      () => runSessionIncarnations.id,
      { onDelete: "set null" },
    ),
    kind: text("kind", { enum: RUNTIME_OBJECT_KINDS }).notNull(),
    logicalName: text("logical_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    sha256: text("sha256"),
    generation: integer("generation").notNull(),
    retentionClass: text("retention_class", {
      enum: RUNTIME_OBJECT_RETENTION_CLASSES,
    }).notNull(),
    state: text("state", { enum: RUNTIME_OBJECT_STATES }).notNull(),
    sourceEventId: text("source_event_id").references(
      () => executionEvents.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    sealedAt: timestamp("sealed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
  },
  (t) => ({
    uniqSourceEvent: uniqueIndex("execution_runtime_objects_source_event_uq")
      .on(t.sourceEventId)
      .where(sql`${t.sourceEventId} IS NOT NULL`),
    idxRunState: index("execution_runtime_objects_run_state_idx").on(
      t.runId,
      t.state,
    ),
    idxExpiry: index("execution_runtime_objects_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    sizeCheck: check(
      "execution_runtime_objects_size_check",
      sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`,
    ),
    generationCheck: check(
      "execution_runtime_objects_generation_check",
      sql`${t.generation} >= 1`,
    ),
    logicalNameCheck: check(
      "execution_runtime_objects_logical_name_check",
      sql`char_length(${t.logicalName}) BETWEEN 1 AND 255 AND ${t.logicalName} NOT IN ('.', '..') AND ${t.logicalName} !~ '[\\\\/]'`,
    ),
    metadataStateCheck: check(
      "execution_runtime_objects_metadata_state_check",
      sql`(${t.state} IN ('available', 'deleting', 'missing', 'deleted', 'expired', 'corrupt')) = (${t.sizeBytes} IS NOT NULL AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.sealedAt} IS NOT NULL)`,
    ),
    ephemeralExpiryCheck: check(
      "execution_runtime_objects_ephemeral_expiry_check",
      sql`(${t.retentionClass} = 'ephemeral') = (${t.expiresAt} IS NOT NULL)`,
    ),
  }),
);

export const executionEventConsumers = pgTable(
  "execution_event_consumers",
  {
    consumerName: text("consumer_name").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    lastRunSequence: bigint("last_run_sequence", { mode: "bigint" }),
    state: text("state", { enum: ["ready", "retrying", "poisoned"] })
      .notNull()
      .default("ready"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "date",
    }),
    poisonEventId: text("poison_event_id").references(
      () => executionEvents.id,
      { onDelete: "set null" },
    ),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastServedAt: timestamp("last_served_at", {
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
    primary: primaryKey({ columns: [t.consumerName, t.runId] }),
    idxRetry: index("execution_event_consumers_retry_idx").on(
      t.nextRetryAt,
      t.claimExpiresAt,
    ),
    idxService: index("execution_event_consumers_service_idx")
      .on(t.lastServedAt.asc().nullsFirst(), t.runId, t.consumerName)
      .where(sql`${t.state} <> 'poisoned'`),
  }),
);

export const executionProjectionBackfills = pgTable(
  "execution_projection_backfills",
  {
    consumerName: text("consumer_name").primaryKey(),
    afterRunId: text("after_run_id"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
);

export const executionDataPlaneImports = pgTable(
  "execution_data_plane_imports",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind", {
      enum: [
        "events",
        "transcript",
        "cost",
        "runtime_objects",
        "scratch_session",
      ],
    }).notNull(),
    state: text("state", { enum: ["pending", "complete", "missing", "failed"] })
      .notNull()
      .default("pending"),
    sourceFingerprint: text("source_fingerprint"),
    lastSourcePosition: text("last_source_position"),
    importedCount: integer("imported_count").notNull().default(0),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => ({ primary: primaryKey({ columns: [t.runId, t.sourceKind] }) }),
);

export const executionEventIngestFailures = pgTable(
  "execution_event_ingest_failures",
  {
    id: text("id").primaryKey(),
    executionHostId: text("execution_host_id")
      .notNull()
      .references(() => executionHosts.id, { onDelete: "restrict" }),
    streamId: text("stream_id"),
    eventIdText: text("event_id_text"),
    sequenceText: text("sequence_text"),
    reason: text("reason").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    encodedBytes: integer("encoded_bytes").notNull().default(0),
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqFailure: unique("execution_event_ingest_failures_identity_uq").on(
      t.executionHostId,
      t.streamId,
      t.eventIdText,
      t.sequenceText,
      t.reason,
    ),
  }),
);

export type ExecutionEvent = typeof executionEvents.$inferSelect;
export type ExecutionEventStream = typeof executionEventStreams.$inferSelect;
export type RunSessionIncarnation = typeof runSessionIncarnations.$inferSelect;
export type ExecutionRuntimeObject =
  typeof executionRuntimeObjects.$inferSelect;

export const runCostRollups = pgTable(
  "run_cost_rollups",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    flowId: text("flow_id").references(() => flows.id, {
      onDelete: "set null",
    }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    resumeInputTokens: integer("resume_input_tokens").notNull().default(0),
    resumeOutputTokens: integer("resume_output_tokens").notNull().default(0),
    resumeCacheReadTokens: integer("resume_cache_read_tokens")
      .notNull()
      .default(0),
    resumeCacheCreationTokens: integer("resume_cache_creation_tokens")
      .notNull()
      .default(0),
    byModel: jsonb("by_model")
      .$type<Record<string, Record<string, number>>>()
      .notNull()
      .default({}),
    bySession: jsonb("by_session")
      .$type<Record<string, Record<string, number>>>()
      .notNull()
      .default({}),
    // ADR-117 (migration 0083): per-runner token breakdown, keyed by the
    // snapshot-derived stable label "<adapter>/<model>" (or "unknown" for cost
    // with no matching run_sessions row). Symmetric to by_model.
    byRunner: jsonb("by_runner")
      .$type<Record<string, Record<string, number>>>()
      .notNull()
      .default({}),
    sourceEventCount: integer("source_event_count").notNull().default(0),
    sourceCursor: text("source_cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProjectFlow: index("run_cost_rollups_project_flow_idx").on(
      t.projectId,
      t.flowId,
    ),
  }),
);

export const repoDeliveryRollups = pgTable(
  "repo_delivery_rollups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    bucketStart: timestamp("bucket_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    bucketEnd: timestamp("bucket_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    commits: integer("commits").notNull().default(0),
    mergePrUnits: integer("merge_pr_units").notNull().default(0),
    additions: bigint("additions", { mode: "number" }).notNull().default(0),
    deletions: bigint("deletions", { mode: "number" }).notNull().default(0),
    deliveryRefs: jsonb("delivery_refs")
      .$type<RepoDeliveryRef[]>()
      .notNull()
      .default([]),
    providerComplete: boolean("provider_complete").notNull().default(true),
    fetchedAt: timestamp("fetched_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    headSha: text("head_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectBranchBucket: unique(
      "repo_delivery_rollups_project_branch_bucket_uq",
    ).on(t.projectId, t.branch, t.bucketStart, t.bucketEnd),
    idxProjectBranchBucket: index(
      "repo_delivery_rollups_project_branch_bucket_idx",
    ).on(t.projectId, t.branch, t.bucketStart),
    idxProjectFetched: index("repo_delivery_rollups_project_fetched_idx").on(
      t.projectId,
      t.fetchedAt,
    ),
    nonNegativeCheck: check(
      "repo_delivery_rollups_non_negative_check",
      sql`${t.commits} >= 0 AND ${t.mergePrUnits} >= 0 AND ${t.additions} >= 0 AND ${t.deletions} >= 0`,
    ),
    bucketOrderCheck: check(
      "repo_delivery_rollups_bucket_order_check",
      sql`${t.bucketEnd} > ${t.bucketStart}`,
    ),
  }),
);

export type WorkspaceLifecycleOperationName =
  | "archive"
  | "drop"
  | "discard"
  | "retention_gc"
  | "reconciliation"
  | "exportBranch"
  | "snapshotCommit"
  | "handoffBranch"
  | "sync";

export type WorkspacePreservationOutcome =
  | "not_needed"
  | "ref_created"
  | "snapshot_created"
  | "legacy_unknown";

export type WorkspaceRemovalKind =
  | "archive"
  | "drop"
  | "discard"
  | "retention_gc"
  | "reconciliation"
  | "legacy";

export type WorkspaceReconciliationFindingState =
  | "observed"
  | "held"
  | "retry_waiting"
  | "failed"
  | "quarantined"
  | "resolved";

export type WorkspaceReconciliationCandidateKind =
  | "row_missing_path"
  | "row_removed_path"
  | "rowless_managed"
  | "untrusted";

export const workspaces = pgTable(
  "workspaces",
  {
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
    archivedCommit: text("archived_commit"),
    preservationOutcome: text(
      "preservation_outcome",
    ).$type<WorkspacePreservationOutcome | null>(),
    removalKind: text("removal_kind").$type<WorkspaceRemovalKind | null>(),
    baseBranch: text("base_branch"),
    baseCommit: text("base_commit"),
    targetBranch: text("target_branch"),
    promotionMode: text("promotion_mode"),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    promotedAt: timestamp("promoted_at", { withTimezone: true, mode: "date" }),
    promotionState: text("promotion_state").notNull().default("none"),
    // ADR-126: lane class written by promoteRun finalize when the input carries
    // auto-promotion attribution — the queryable "auto" glyph datum. NULL ⇒ the
    // run was promoted manually (or not yet promoted).
    promotionLane: text("promotion_lane").$type<LaneClass | null>(),
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
    lifecycleOperationLeaseExpiresAt: timestamp(
      "lifecycle_operation_lease_expires_at",
      { withTimezone: true, mode: "date" },
    ),
    lifecycleOperationAttemptId: text("lifecycle_operation_attempt_id"),
    lifecycleOperationName: text(
      "lifecycle_operation_name",
    ).$type<WorkspaceLifecycleOperationName | null>(),
    lifecycleOperationExpectedRunStatus: text(
      "lifecycle_operation_expected_run_status",
    ),
    // ADR-140 (migration 0105): PR lifecycle tracking. `pr_state` NULL = never
    // scanned, and is written ONLY from a SUCCESSFUL provider read — a failed
    // read leaves it untouched, because no writer here could ever undo a wrong
    // `closed` (the scan's candidate query selects NULL/'open' only).
    // `pr_merge_commit_sha` is the PROVIDER merge commit (provenance only) —
    // distinct from `runs.merge_commit_sha`, which stays owned by the
    // repo_delivery_scan (ADR-134).
    prState: text("pr_state", { enum: ["open", "merged", "closed"] }),
    prHasConflicts: boolean("pr_has_conflicts"),
    prMergedAt: timestamp("pr_merged_at", { withTimezone: true, mode: "date" }),
    prMergeCommitSha: text("pr_merge_commit_sha"),
  },
  (t) => ({
    lifecycleClaimIndex: index("workspaces_lifecycle_claim_idx").on(
      t.lifecycleOperationState,
      t.lifecycleOperationLeaseExpiresAt,
    ),
    lifecycleClaimShapeCheck: check(
      "workspaces_lifecycle_claim_shape_check",
      sql`(
        (${t.lifecycleOperationState} = 'none'
          AND ${t.lifecycleOperationAttemptId} IS NULL
          AND ${t.lifecycleOperationName} IS NULL
          AND ${t.lifecycleOperationExpectedRunStatus} IS NULL
          AND ${t.lifecycleOperationLeaseExpiresAt} IS NULL)
        OR
        (${t.lifecycleOperationState} = 'claiming'
          AND ${t.lifecycleOperationAttemptId} IS NOT NULL
          AND ${t.lifecycleOperationName} IS NOT NULL
          AND ${t.lifecycleOperationExpectedRunStatus} IS NOT NULL
          AND ${t.lifecycleOperationLeaseExpiresAt} IS NOT NULL)
        OR
        (${t.lifecycleOperationState} = 'failed'
          AND ${t.lifecycleOperationAttemptId} IS NOT NULL
          AND ${t.lifecycleOperationName} IS NOT NULL
          AND ${t.lifecycleOperationExpectedRunStatus} IS NOT NULL
          AND ${t.lifecycleOperationLeaseExpiresAt} IS NULL)
      )`,
    ),
    preservationOutcomeCheck: check(
      "workspaces_preservation_outcome_check",
      sql`${t.preservationOutcome} IS NULL OR ${t.preservationOutcome} IN ('not_needed', 'ref_created', 'snapshot_created', 'legacy_unknown')`,
    ),
    removalKindCheck: check(
      "workspaces_removal_kind_check",
      sql`${t.removalKind} IS NULL OR ${t.removalKind} IN ('archive', 'drop', 'discard', 'retention_gc', 'reconciliation', 'legacy')`,
    ),
    removedWorkspaceResultCheck: check(
      "workspaces_removed_result_check",
      sql`${t.removedAt} IS NULL OR ${t.removalKind} IS NOT NULL`,
    ),
    prStateCheck: check(
      "workspaces_pr_state_check",
      sql`${t.prState} in ('open', 'merged', 'closed')`,
    ),
    // Partial index backing the pr_state_scan candidate query (decision 2).
    prStateScanIdx: index("workspaces_pr_state_scan_idx")
      .on(t.projectId)
      .where(
        sql`${t.prUrl} is not null and (${t.prState} is null or ${t.prState} = 'open')`,
      ),
  }),
);

// ADR-141 (migration 0106): append-only branch-sync attempt ledger, one row per
// sync/resolver attempt on a run. Shaped like node_attempts — `phase` is the
// single plain-text lifecycle column (TS-only enum, NO DB CHECK), written BEFORE
// each side effect.
export const RUN_SYNC_PHASES = [
  "starting",
  "rebasing",
  "agent_running",
  "verifying",
  "pushing",
  "succeeded",
  "failed",
  "aborted",
] as const;
export type RunSyncPhase = (typeof RUN_SYNC_PHASES)[number];

// The terminal subset. `satisfies` ties it to the phase enum above, so a rename
// there fails HERE rather than silently leaving a filter matching nothing. This
// exact array was re-listed in five modules (sync-target, sync-recovery,
// sync-panel-data, reconcile, keepalive-sweeper) with no shared definition.
export const RUN_SYNC_TERMINAL_PHASES = [
  "succeeded",
  "failed",
  "aborted",
] as const satisfies readonly RunSyncPhase[];

export const runSyncAttempts = pgTable(
  "run_sync_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    strategy: text("strategy", { enum: ["rebase", "merge"] }).notNull(),
    mode: text("mode", { enum: ["mechanical", "agent"] }).notNull(),
    phase: text("phase", { enum: RUN_SYNC_PHASES })
      .notNull()
      .default("starting"),
    targetRef: text("target_ref"),
    targetSha: text("target_sha"),
    headShaBefore: text("head_sha_before"),
    headShaAfter: text("head_sha_after"),
    // captured via `git ls-remote` BEFORE the fetch, for the explicit-SHA
    // force-with-lease (decision 11). The fetch is `git fetch origin` with NO
    // refspec, so it DOES refresh `origin/<branch>` — which is exactly why this
    // is captured first and why the lease names a SHA instead of relying on the
    // tracking ref.
    remoteShaBefore: text("remote_sha_before"),
    conflictedFiles: jsonb("conflicted_files").$type<string[]>(),
    // resolved runner SNAPSHOT (plain text, no FK — the terminal path reads this,
    // never re-resolves; runner deletion must not mutate a historical attempt).
    runnerId: text("runner_id"),
    sessionName: text("session_name"),
    // active-time duration cap: stamped at Review->Running launch, re-stamped on
    // every NeedsInput->Running HITL resume (decision 16).
    agentRunningSince: timestamp("agent_running_since", {
      withTimezone: true,
      mode: "date",
    }),
    // the ai_rebase_merge autoFinalize toggle (decision 19), default OFF.
    autoFinalize: boolean("auto_finalize").notNull().default(false),
    pushed: boolean("pushed").notNull().default(false),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRunAttempt: unique("run_sync_attempts_run_attempt_uq").on(
      t.runId,
      t.attempt,
    ),
    idxRun: index("run_sync_attempts_run_idx").on(t.runId),
  }),
);

export type RunSyncAttemptRow = typeof runSyncAttempts.$inferSelect;
export type RunSyncAttemptInsert = typeof runSyncAttempts.$inferInsert;
// ADR-148: bounded operational state for filesystem/DB convergence. This is
// deliberately not run history and stores a root-relative path only.
export const workspaceReconciliationFindings = pgTable(
  "workspace_reconciliation_findings",
  {
    id: text("id").primaryKey(),
    identityFingerprint: text("identity_fingerprint").notNull().unique(),
    candidateKind: text("candidate_kind")
      .$type<WorkspaceReconciliationCandidateKind>()
      .notNull(),
    relativePath: text("relative_path").notNull(),
    provenanceVersion: integer("provenance_version"),
    provenanceFingerprint: text("provenance_fingerprint"),
    provenanceRunId: text("provenance_run_id"),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<WorkspaceReconciliationFindingState>().notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    armedAt: timestamp("armed_at", { withTimezone: true, mode: "date" }),
    nextRetryAt: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "date",
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retryGeneration: integer("retry_generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    attemptId: text("attempt_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    resultCode: text("result_code"),
    rescueRef: text("rescue_ref"),
    rescueCommit: text("rescue_commit"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    dueStateIndex: index("workspace_reconciliation_findings_due_idx").on(
      table.state,
      table.nextRetryAt,
      table.firstSeenAt,
    ),
    provenanceRunIndex: index(
      "workspace_reconciliation_findings_provenance_run_idx",
    ).on(table.provenanceRunId),
    correlationIndex: index(
      "workspace_reconciliation_findings_correlation_idx",
    ).on(table.projectId, table.runId, table.workspaceId),
    candidateKindCheck: check(
      "workspace_reconciliation_findings_candidate_kind_check",
      sql`${table.candidateKind} IN ('row_missing_path', 'row_removed_path', 'rowless_managed', 'untrusted')`,
    ),
    stateCheck: check(
      "workspace_reconciliation_findings_state_check",
      sql`${table.state} IN ('observed', 'held', 'retry_waiting', 'failed', 'quarantined', 'resolved')`,
    ),
    rescueEvidenceCheck: check(
      "workspace_reconciliation_findings_rescue_evidence_check",
      sql`(${table.rescueRef} IS NULL) = (${table.rescueCommit} IS NULL)`,
    ),
    claimShapeCheck: check(
      "workspace_reconciliation_findings_claim_shape_check",
      sql`(${table.attemptId} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    attemptCountCheck: check(
      "workspace_reconciliation_findings_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    resolvedShapeCheck: check(
      "workspace_reconciliation_findings_resolved_shape_check",
      sql`(${table.state} = 'resolved') = (${table.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

export type RunScheduleOverlapPolicy = "skip" | "queue_one" | "start_anyway";
export type RunScheduleFireOutcome =
  | "launched"
  | "queued_pending"
  | "catchup_queued"
  | "skipped_task_busy"
  | "skipped_cap"
  | "skipped_target_terminal"
  | "skipped_crashed"
  | "skipped_flagged"
  | "skipped_blocked"
  | "skipped_unconfigured"
  | "launch_failed"
  | "incompatible_disabled"
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
        "skipped_flagged",
        "skipped_blocked",
        "skipped_unconfigured",
        "launch_failed",
        "incompatible_disabled",
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
    // M36 Phase 5 (ADR-097): NULLABLE — exactly one of project_id /
    // local_package_id is set (DB CHECK). A project scratch run keeps
    // project_id; a docked-assistant run rooted at a local-package working dir
    // sets local_package_id and leaves project_id NULL.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    localPackageId: text("local_package_id").references(
      () => localPackages.id,
      { onDelete: "cascade" },
    ),
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
    // Partial — still serves project scratch rows; the project-less
    // (local_package_id) rows are excluded so a NULL project_id never widens it.
    idxProjectStatus: index("scratch_runs_project_status_idx")
      .on(t.projectId, t.dialogStatus)
      .where(sql`${t.projectId} IS NOT NULL`),
    idxLocalPackage: index("scratch_runs_local_package_idx")
      .on(t.localPackageId, t.dialogStatus)
      .where(sql`${t.localPackageId} IS NOT NULL`),
    // ADR-097: exactly one of project_id / local_package_id (never both, never
    // neither). Mirrors local_packages' own (project_id XOR named) intent.
    ownerXorCheck: check(
      "scratch_runs_owner_xor_check",
      sql`(${t.projectId} IS NOT NULL) <> (${t.localPackageId} IS NOT NULL)`,
    ),
  }),
);

// Run-detail transparency (T-B1b, migration 0085): generalized from
// `scratch_messages`. Run-kind-agnostic transcript store shared by scratch AND
// flow `ai_coding` node sessions. `run_id` references the general `runs` table
// (scratch_runs.run_id == runs.id, so the rename preserved every existing row);
// `node_attempt_id` is NULL for scratch / single-session runs and set per node
// attempt for flow runs. The unique `(run_id, node_attempt_id, sequence)` uses
// NULLS NOT DISTINCT so scratch (NULL attempt) keeps its `(run_id, sequence)`
// invariant while flow rows are unique per node attempt.
export const runMessages = pgTable(
  "run_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeAttemptId: text("node_attempt_id").references(() => nodeAttempts.id, {
      onDelete: "cascade",
    }),
    sequence: integer("sequence").notNull(),
    role: text("role", {
      enum: ["user", "assistant", "tool", "system"],
    }).notNull(),
    content: text("content").notNull(),
    supervisorEventId: text("supervisor_event_id"),
    projectionToolKey: text("projection_tool_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxProjectionTool: index("run_messages_projection_tool_idx")
      .on(t.runId, t.nodeAttemptId, t.projectionToolKey, t.sequence.desc())
      .where(sql`${t.projectionToolKey} IS NOT NULL`),
    uniqRunNodeAttemptSequence: unique(
      "run_messages_run_node_attempt_sequence_uq",
    )
      .on(t.runId, t.nodeAttemptId, t.sequence)
      .nullsNotDistinct(),
  }),
);

export const runTranscriptStates = pgTable(
  "run_transcript_states",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeAttemptId: text("node_attempt_id").references(() => nodeAttempts.id, {
      onDelete: "cascade",
    }),
    nextSequence: integer("next_sequence").notNull().default(0),
    openTextSequence: integer("open_text_sequence"),
    openThoughtSequence: integer("open_thought_sequence"),
    usageSequence: integer("usage_sequence"),
  },
  (t) => ({
    uniqScope: unique("run_transcript_states_run_attempt_uq")
      .on(t.runId, t.nodeAttemptId)
      .nullsNotDistinct(),
  }),
);

// Back-compat alias (T-B1b). Scratch code reads/writes the same table under the
// historical name (node_attempt_id stays NULL for scratch). The canonical name
// is `runMessages`; the flow transcript projector uses it directly.
export const scratchMessages = runMessages;

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
    | "workspaceAccess"
    | "hooks";
  declared: "strict" | "instruct" | "off";
  capability: "enforced" | "instructed" | "unsupported";
  verdict: "enforced" | "instructed" | "refused";
};

// Append-only per-node-attempt ledger written by the graph runner. `attempt`
// auto-increments per (run, node); rework never mutates a prior row.
export const nodeAttempts = pgTable(
  "node_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    // The DB column is plain text (no CHECK), so this enum is TS-level only.
    nodeType: text("node_type", {
      enum: [
        "ai_coding",
        "cli",
        "check",
        "judge",
        "human",
        "form",
        "orchestrator",
        "consensus",
      ],
    }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    // PascalCase node-lifecycle vocabulary. Distinct from gate_results.status.
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
    // ADR-160: the branch HEAD at the instant a human CLAIM row was appended
    // (ADR-030 takeover and ADR-160 rework claim alike). Written only on claim
    // rows — the return compares it against the live tip to tell whether the
    // operator actually committed anything, which the merge-base range cannot:
    // a finished run's branch already carries every commit the flow made.
    // Nullable: rows claimed before this column existed, and claims where the
    // SHA could not be read, fall back to the historical merge-base count.
    claimHeadSha: text("claim_head_sha"),
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
    // The final Mustache-resolved prompt sent to an ai_coding/judge node,
    // captured at dispatch (migration 0053). Null for cli/check/human nodes and
    // for attempts created before the column shipped.
    resolvedPrompt: text("resolved_prompt"),
    // ADR-118 (migration 0086): the attempt number at which this node's CURRENT
    // rework epoch began. NULL ⇒ baseline 0 (byte-identical to pre-ADR-118). The
    // effective attempt count the loop bounds against is
    // `attempt - (rework_baseline ?? 0)`; appendNodeAttempt carries it forward,
    // a human-node rework with `resetTargets` re-stamps it to the target's
    // current attempt count → a fresh maxLoops budget.
    reworkBaseline: integer("rework_baseline"),
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
    // ADR-162 (migration 0127): which structured-output contract judged this
    // attempt. Written on the SAME ledger UPDATE that closes the attempt, on
    // the success path AND on the seam-failure path; markNodeReworked never
    // clears it. NULL means the node declared no `output.result`, the row
    // predates the column, or the seam failed before the schema was resolved
    // (no identity exists then). Engine metadata — deliberately NOT in `vars`,
    // which is the flow-visible plane, and not projected into any client DTO.
    outputContract: jsonb(
      "output_contract",
    ).$type<NodeAttemptOutputContract | null>(),
    // ADR-166 (migration 0130): the assignment epoch this attempt ran under —
    // stamped at attempt start, immutable.
    executionAssignmentId: text("execution_assignment_id").references(
      () => executionAssignments.id,
      { onDelete: "set null" },
    ),
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
    idxAssignment: index("node_attempts_assignment_idx").on(
      t.executionAssignmentId,
    ),
  }),
);

export const nodeAttemptCostRollups = pgTable(
  "node_attempt_cost_rollups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    nodeAttemptId: text("node_attempt_id")
      .notNull()
      .references(() => nodeAttempts.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    resumeInputTokens: integer("resume_input_tokens").notNull().default(0),
    resumeOutputTokens: integer("resume_output_tokens").notNull().default(0),
    resumeCacheReadTokens: integer("resume_cache_read_tokens")
      .notNull()
      .default(0),
    resumeCacheCreationTokens: integer("resume_cache_creation_tokens")
      .notNull()
      .default(0),
    sourceEventCount: integer("source_event_count").notNull().default(0),
    sourceCursor: text("source_cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAttemptModel: unique("node_attempt_cost_rollups_attempt_model_uq").on(
      t.nodeAttemptId,
      t.model,
    ),
    idxRunAttempt: index("node_attempt_cost_rollups_run_attempt_idx").on(
      t.runId,
      t.nodeAttemptId,
    ),
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
  | { kind: "execution-object"; objectId: string }
  | { kind: "gate-verdict"; gateResultId: string }
  | { kind: "hitl-response"; hitlRequestId: string }
  | {
      kind: "inline";
      text: string;
      // ADR-138 (additive, OpenAPI ArtifactLocatorInline): set on the
      // composed-rework-payload evidence row (kind human_note, producer
      // runner) — the authoring review-gate id, thread ids, and an immutable
      // fingerprint of the packet serialized into `text` at compose time.
      hitlRequestId?: string;
      threadIds?: string[];
      feedbackFingerprint?: string;
    };

// ADR-165 (0129): the PUBLIC result plane — one row per result REVISION of a
// run, any run kind. `invalid` rows are first-class: they are the ONE durable
// source for a coordinator's `resultFailure` reason. Plane-separated from
// `artifact_instances` on purpose (ADR-162 D7): artifacts are node-keyed
// evidence with a currency FSM; a result is a run-level public contract with
// revisions and a supersession chain, and an agent run has no node identity at
// all.
export const runResults = pgTable(
  "run_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // 1-based, unique per run. The revision sequence is a database fact.
    revision: integer("revision").notNull(),
    validity: text("validity").$type<RunResultValidity>().notNull(),
    // `<flowRefId>@<resolvedRevision[:12]>:<schemaStem>` — derived from server
    // state alone, never from a request body.
    schemaRef: text("schema_ref").notNull(),
    // sha256 over the schema document's EXACT bytes, so a schema edited under a
    // stable package ref is detectable from this row after the fact.
    schemaSha256: text("schema_sha256").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    producerKind: text("producer_kind")
      .$type<RunResultProducerKind>()
      .notNull(),
    // A flow node id, or `session:default` for an agent session.
    producerRef: text("producer_ref").notNull(),
    nodeAttemptId: text("node_attempt_id").references(() => nodeAttempts.id, {
      onDelete: "set null",
    }),
    // NULL iff validity = 'invalid' (CHECK). Open JSON: undeclared nested keys
    // are preserved exactly as the producer emitted them.
    value: jsonb("value"),
    valueBytes: integer("value_bytes").notNull(),
    // NOT NULL iff validity = 'invalid' (CHECK).
    invalidReason: text("invalid_reason").$type<RunResultInvalidReason>(),
    // The engine artifact manifest AT PUBLISH (audit). `run_collect.artifacts`
    // is deliberately the LIVE manifest instead.
    artifactManifest: jsonb("artifact_manifest")
      .$type<RunResultArtifactRef[]>()
      .notNull()
      .default([]),
    engineVersion: text("engine_version").notNull(),
    supersededById: text("superseded_by_id").references(
      (): AnyPgColumn => runResults.id,
      { onDelete: "set null" },
    ),
    supersededAt: timestamp("superseded_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Write-once: `markRunResultCollected` guards on IS NULL, so repeated
    // collects never move it. This is half of the Lab's "did the parent USE the
    // results?" intersection metric.
    firstCollectedAt: timestamp("first_collected_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRunRevision: unique("run_results_run_revision_uq").on(
      t.runId,
      t.revision,
    ),
    // "At most one CURRENT result per run" as a database fact — a second
    // `valid` INSERT that bypasses the publish helper violates this rather than
    // silently winning.
    uniqOneValidPerRun: uniqueIndex("run_results_one_valid_per_run_uq")
      .on(t.runId)
      .where(sql`${t.validity} = 'valid'`),
    idxRun: index("run_results_run_idx").on(t.runId),
    validityCheck: check(
      "run_results_validity_check",
      sql`${t.validity} IN ('valid','stale','superseded','invalid')`,
    ),
    producerKindCheck: check(
      "run_results_producer_kind_check",
      sql`${t.producerKind} IN ('flow_node','agent_session')`,
    ),
    // The mutual exclusion, both directions. A CHECK the schema never learned
    // makes `drizzle-kit generate` propose reverting it, so both live here.
    valueShapeCheck: check(
      "run_results_value_shape_check",
      sql`(${t.validity} = 'invalid') = (${t.value} IS NULL)`,
    ),
    invalidReasonCheck: check(
      "run_results_invalid_reason_check",
      sql`(${t.validity} = 'invalid') = (${t.invalidReason} IS NOT NULL)`,
    ),
  }),
);

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
        "plan",
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

export type ConsensusVerdictParseStatus =
  | "parsed"
  | "invalid_json"
  | "invalid_schema"
  | "missing_axes"
  | "unknown_axes";

export type ConsensusRoundDisagreement = {
  axis: string;
  claim: string;
  counterEvidence: string;
};

export const consensusRoundVerdicts = pgTable(
  "consensus_round_verdicts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeAttemptId: text("node_attempt_id")
      .notNull()
      .references(() => nodeAttempts.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    verifierKey: text("verifier_key").notNull(),
    targetKey: text("target_key").notNull(),
    parseStatus: text("parse_status", {
      enum: [
        "parsed",
        "invalid_json",
        "invalid_schema",
        "missing_axes",
        "unknown_axes",
      ],
    }).notNull(),
    verdict: text("verdict", { enum: ["agree", "disagree"] }).notNull(),
    axes: jsonb("axes").$type<Record<string, boolean>>().notNull().default({}),
    disagreements: jsonb("disagreements")
      .$type<ConsensusRoundDisagreement[]>()
      .notNull()
      .default([]),
    confidence: real("confidence"),
    rawOutputArtifactId: text("raw_output_artifact_id").references(
      () => artifactInstances.id,
      { onDelete: "set null" },
    ),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqAttemptRoundPair: unique(
      "consensus_round_verdicts_attempt_round_pair_uq",
    ).on(t.nodeAttemptId, t.round, t.verifierKey, t.targetKey),
    idxRun: index("consensus_round_verdicts_run_idx").on(t.runId),
    idxNodeAttempt: index("consensus_round_verdicts_node_attempt_idx").on(
      t.nodeAttemptId,
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
        "agent_question",
        "human_review",
        "manual_takeover",
        "merge_conflict",
        "infra_recovery",
        "budget_breach",
        "hook_trip",
        // ADR-161: the assignment for a node_interrupt HITL. TS-only —
        // `assignments.action_kind` carries no DB CHECK
        // (0018_m13_assignment_actors.sql), so this value needs no migration.
        "node_interrupt",
        "decision_request",
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
    kind: text("kind", {
      enum: [
        "permission",
        "form",
        "human",
        "agent_question",
        "infra_recovery",
        "budget_breach",
        "hook_trip",
        // ADR-161: an operator paused a live agent node mid-turn. TS-only —
        // `hitl_requests.kind` carries no DB CHECK (0000_clumsy_nightshade.sql),
        // so this value needs no migration.
        "node_interrupt",
        "decision_request",
      ],
    }).notNull(),
    schema: jsonb("schema"),
    prompt: text("prompt").notNull(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "cascade",
    }),
    activationState: text("activation_state", {
      enum: ["pending_termination", "active", "failed"],
    }),
    reTriggerMode: text("retrigger_mode", {
      enum: ["agent", "triage"],
    }),
    supersededAt: timestamp("superseded_at", {
      withTimezone: true,
      mode: "date",
    }),
    supersededByHitlRequestId: text("superseded_by_hitl_request_id"),
    supersededByRunId: text("superseded_by_run_id"),
    response: jsonb("response"),
    parentHitlRequestId: text("parent_hitl_request_id").references(
      (): AnyPgColumn => hitlRequests.id,
      { onDelete: "cascade" },
    ),
    sourceArtifactId: text("source_artifact_id").references(
      () => artifactInstances.id,
      { onDelete: "cascade" },
    ),
    decisionId: text("decision_id"),
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
    uniqDecisionRequest: uniqueIndex("hitl_requests_decision_request_uq")
      .on(t.runId, t.sourceArtifactId, t.decisionId)
      .where(sql`${t.kind} = 'decision_request'`),
    idxPendingDecisionRequests: index("hitl_requests_pending_decision_idx")
      .on(t.parentHitlRequestId, t.respondedAt, t.createdAt)
      .where(sql`${t.kind} = 'decision_request'`),
    decisionRequestShapeCheck: check(
      "hitl_requests_decision_request_shape_check",
      sql`(
        ${t.kind} = 'decision_request'
        AND ${t.parentHitlRequestId} IS NOT NULL
        AND ${t.sourceArtifactId} IS NOT NULL
        AND ${t.decisionId} IS NOT NULL
        AND ${t.schema} IS NOT NULL
      ) OR (
        ${t.kind} <> 'decision_request'
        AND ${t.parentHitlRequestId} IS NULL
        AND ${t.sourceArtifactId} IS NULL
        AND ${t.decisionId} IS NULL
      )`,
    ),
    idxAgentQuestionActive: index("hitl_requests_agent_question_active_idx")
      .on(t.taskId, t.createdAt)
      .where(
        sql`${t.kind} = 'agent_question' AND ${t.activationState} = 'active' AND ${t.respondedAt} IS NULL AND ${t.supersededAt} IS NULL`,
      ),
    agentQuestionShapeCheck: check(
      "hitl_requests_agent_question_shape_check",
      sql`(
        ${t.kind} = 'agent_question'
        AND ${t.taskId} IS NOT NULL
        AND ${t.activationState} IS NOT NULL
        AND ${t.reTriggerMode} IS NOT NULL
        AND ${t.schema} IS NOT NULL
      ) OR (
        ${t.kind} <> 'agent_question'
        AND ${t.taskId} IS NULL
        AND ${t.activationState} IS NULL
        AND ${t.reTriggerMode} IS NULL
      )`,
    ),
    agentQuestionSupersessionCheck: check(
      "hitl_requests_agent_question_supersession_check",
      sql`(
        ${t.kind} <> 'agent_question'
        AND ${t.supersededAt} IS NULL
        AND ${t.supersededByHitlRequestId} IS NULL
        AND ${t.supersededByRunId} IS NULL
      ) OR (
        ${t.kind} = 'agent_question'
        AND (
          (
            ${t.supersededAt} IS NULL
            AND ${t.supersededByHitlRequestId} IS NULL
            AND ${t.supersededByRunId} IS NULL
          ) OR (
            ${t.supersededAt} IS NOT NULL
            AND (
              (${t.supersededByHitlRequestId} IS NOT NULL AND ${t.supersededByRunId} IS NULL)
              OR (${t.supersededByHitlRequestId} IS NULL AND ${t.supersededByRunId} IS NOT NULL)
            )
          )
        )
      )`,
    ),
    agentQuestionActivationStateCheck: check(
      "hitl_requests_agent_question_activation_state_check",
      sql`${t.activationState} IS NULL OR ${t.activationState} IN ('pending_termination', 'active', 'failed')`,
    ),
    agentQuestionRetriggerModeCheck: check(
      "hitl_requests_agent_question_retrigger_mode_check",
      sql`${t.reTriggerMode} IS NULL OR ${t.reTriggerMode} IN ('agent', 'triage')`,
    ),
  }),
);

export const taskClarifications = pgTable(
  "task_clarifications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    sourceHitlRequestId: text("source_hitl_request_id").notNull(),
    originRunId: text("origin_run_id").notNull(),
    originAgentId: text("origin_agent_id").notNull(),
    question: text("question").notNull(),
    questionSchema: jsonb("question_schema").notNull(),
    reTriggerMode: text("retrigger_mode", {
      enum: ["agent", "triage"],
    }).notNull(),
    answer: jsonb("answer"),
    answeredByUserId: text("answered_by_user_id"),
    answeredAt: timestamp("answered_at", {
      withTimezone: true,
      mode: "date",
    }),
    supersededAt: timestamp("superseded_at", {
      withTimezone: true,
      mode: "date",
    }),
    supersededByHitlRequestId: text("superseded_by_hitl_request_id"),
    supersededByRunId: text("superseded_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqTaskSequence: unique("task_clarifications_task_seq_uq").on(
      t.taskId,
      t.seq,
    ),
    uniqSourceHitlRequest: unique(
      "task_clarifications_source_hitl_request_uq",
    ).on(t.sourceHitlRequestId),
    idxAnsweredContext: index("task_clarifications_answered_context_idx")
      .on(t.taskId, t.seq, t.id)
      .where(sql`${t.answeredAt} IS NOT NULL AND ${t.supersededAt} IS NULL`),
    sequenceCheck: check(
      "task_clarifications_seq_positive_check",
      sql`${t.seq} > 0`,
    ),
    answerShapeCheck: check(
      "task_clarifications_answer_shape_check",
      sql`(
        ${t.answeredAt} IS NULL
        AND ${t.answer} IS NULL
        AND ${t.answeredByUserId} IS NULL
      ) OR (
        ${t.answeredAt} IS NOT NULL
        AND ${t.answer} IS NOT NULL
        AND ${t.answeredByUserId} IS NOT NULL
      )`,
    ),
    supersessionCheck: check(
      "task_clarifications_supersession_check",
      sql`(
        ${t.supersededAt} IS NULL
        AND ${t.supersededByHitlRequestId} IS NULL
        AND ${t.supersededByRunId} IS NULL
      ) OR (
        ${t.supersededAt} IS NOT NULL
        AND (
          (${t.supersededByHitlRequestId} IS NOT NULL AND ${t.supersededByRunId} IS NULL)
          OR (${t.supersededByHitlRequestId} IS NULL AND ${t.supersededByRunId} IS NOT NULL)
        )
      )`,
    ),
    reTriggerModeCheck: check(
      "task_clarifications_retrigger_mode_check",
      sql`${t.reTriggerMode} IN ('agent', 'triage')`,
    ),
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

// ADR-138: a durable coordinator for one ACP-backed gate-chat turn. The
// transcript remains in gate_chat_messages; this table records only ownership
// and terminal outcome so an interrupted prompt can be fenced before a review
// decision freezes its feedback packet.
export const gateChatTurns = pgTable(
  "gate_chat_turns",
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
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => gateChatMessages.id, { onDelete: "cascade" }),
    agentMessageId: text("agent_message_id").references(
      () => gateChatMessages.id,
      { onDelete: "set null" },
    ),
    state: text("state", {
      enum: ["pending", "completed", "failed", "aborted"],
    }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    errorCode: text("error_code"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxHitlState: index("gate_chat_turns_hitl_state_idx").on(
      t.hitlRequestId,
      t.state,
    ),
    // PostgreSQL is the final concurrency backstop. Reconciliation owns an
    // expired row until cancellation and L3 restore finish, so expiry alone
    // never reopens chat admission or response claim.
    uniqPendingHitl: uniqueIndex("gate_chat_turns_pending_hitl_uq")
      .on(t.hitlRequestId)
      .where(sql`${t.state} = 'pending'`),
    stateCheck: check(
      "gate_chat_turns_state_check",
      sql`${t.state} in ('pending', 'completed', 'failed', 'aborted')`,
    ),
    pendingLeaseCheck: check(
      "gate_chat_turns_pending_lease_check",
      sql`(${t.state} = 'pending' and ${t.leaseExpiresAt} is not null and ${t.completedAt} is null and ${t.errorCode} is null) or (${t.state} <> 'pending' and ${t.leaseExpiresAt} is null)`,
    ),
    terminalStateCheck: check(
      "gate_chat_turns_terminal_state_check",
      sql`(${t.state} = 'pending' and ${t.agentMessageId} is null) or (${t.state} = 'completed' and ${t.agentMessageId} is not null and ${t.completedAt} is not null and ${t.errorCode} is null) or (${t.state} in ('failed', 'aborted') and ${t.agentMessageId} is null and ${t.completedAt} is not null and ${t.errorCode} is not null)`,
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
// ADR-162: the per-attempt structured-output contract identity persisted on
// `node_attempts.output_contract`. `sha256` hashes the RAW bytes of the
// resolved `output.result.schema` document, so a package edit under a stable
// ref is detectable after the fact.
export type NodeAttemptOutputContract = {
  schemaRef: string;
  schemaVersion: number;
  sha256: string;
  transport: "sentinel" | "file" | "engine_vars";
  engineVersion: string;
};

export type MaterializationPlan = {
  profileDigest: string;
  resolvedRevisions: { refId: string; kind: string; sha: string }[];
  materializedFiles: string[];
  enforcedClasses: string[];
  instructedClasses: string[];
  refusedClasses: string[];
  // ADR-130: per-node MCPs withheld from materialization (trust / exec-trust).
  // Optional so pre-migration plans deserialize without the field.
  withheldMcps?: WithheldMcp[];
  // ADR-130: the derived capability-enforcement set delivered to the supervisor
  // (jsonb, no migration). Null when the node enforces no strict tools/mcps. The
  // Durable launch-time AUDIT snapshot of what was delivered. Not read back on
  // resume — a fresh attempt re-derives it (deterministic on stable inputs).
  enforcementProfile?: {
    tools?: { allow: string[] };
    mcps?: { allowServers: string[] };
    enforcedClasses: ("tools" | "mcps")[];
    escalationThreshold: number;
  } | null;
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
    // ADR-088: membership in an attached package group (null = standalone).
    packageInstallId: text("package_install_id").references(
      () => packageInstalls.id,
    ),
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

// --- Package management (ADR-088, migration 0048) ---------------------------
// Platform catalog of package monorepo sources. `discovered` caches the last
// successful refresh ([{name, tags[]}]); failures keep the stale snapshot.
export const packageSources = pgTable("package_sources", {
  id: text("id").primaryKey(),
  // ADR-132: a git URL for kind 'git'; the ABSOLUTE host directory path for
  // kind 'local' (admin-registered, digest-as-version discovery).
  url: text("url").notNull().unique("package_sources_url_uq"),
  kind: text("kind", { enum: ["git", "local"] })
    .notNull()
    .default("git"),
  // ADR-132: per-source publish PR base (git sources only). NULL =
  // auto-detect the remote default branch, fallback "main".
  baseBranch: text("base_branch"),
  enabled: boolean("enabled").notNull().default(true),
  note: text("note"),
  discovered: jsonb("discovered")
    .$type<DiscoveredPackageEntry[]>()
    .notNull()
    .default([]),
  lastCheckedAt: timestamp("last_checked_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export type DiscoveredPackageEntry = {
  name: string;
  // packages/<dir> subdir in the source monorepo (may differ from name).
  dir: string;
  tags: string[];
  // ADR-132: `local-<digest12>` of the package dir's CURRENT bytes — local
  // sources only (digest-as-version; git sources keep tags).
  digestVersionLabel?: string;
};

// Immutable installed package revision (two-phase Installing → Installed).
// `manifest` holds the parsed maister-package.yaml plus the skills/agents
// inventory; `installed_path` is NEVER projected to clients.
export const packageInstalls = pgTable(
  "package_installs",
  {
    id: text("id").primaryKey(),
    sourceUrl: text("source_url").notNull(),
    name: text("name").notNull(),
    versionLabel: text("version_label").notNull(),
    resolvedRevision: text("resolved_revision").notNull(),
    manifest: jsonb("manifest").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    installedPath: text("installed_path").notNull(),
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
    // M39 Stream B (ADR-107, migration 0074): the back-edge from a cut install
    // to the centralized local package + working-dir commit it was cut from, so
    // a project's attached cut can detect a newer available cut at launch.
    sourceLocalPackageId: text("source_local_package_id").references(
      (): AnyPgColumn => localPackages.id,
      { onDelete: "set null" },
    ),
    sourceCommitSha: text("source_commit_sha"),
  },
  (t) => ({
    uniqSourceNameRevision: unique("package_installs_source_name_rev_uq").on(
      t.sourceUrl,
      t.name,
      t.resolvedRevision,
    ),
  }),
);

// Per-project package enablement: at most one attached version of a package
// name per project. Group membership rides flows.package_install_id +
// capability_imports.package_install_id (one attach/detach transaction).
export const projectPackageAttachments = pgTable(
  "project_package_attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    packageInstallId: text("package_install_id")
      .notNull()
      .references(() => packageInstalls.id, { onDelete: "restrict" }),
    packageName: text("package_name").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqProjectPackage: unique(
      "project_package_attachments_project_name_uq",
    ).on(t.projectId, t.packageName),
  }),
);

// Editable local package (Flow Studio Phase C, Variant B, ADR-096): a
// platform-scoped, git-backed working directory authored/forked artifacts live
// in and `cut version` installs from. `working_dir` is NEVER projected to
// clients. The lock columns mirror runs.keepalive_until for a session edit-lock.
export const localPackages = pgTable(
  "local_packages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    workingDir: text("working_dir").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    sourceInstallId: text("source_install_id").references(
      () => packageInstalls.id,
      { onDelete: "set null" },
    ),
    sourceRepoUrl: text("source_repo_url"),
    sourceRef: text("source_ref"),
    branchName: text("branch_name"),
    lastCutInstallId: text("last_cut_install_id").references(
      () => packageInstalls.id,
      { onDelete: "set null" },
    ),
    lockedByUserId: text("locked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lockedBySession: text("locked_by_session"),
    lockExpiresAt: timestamp("lock_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // M36 (ADR-096): per-project default "virtual" local package for element-level
    // forks. project_id is NULL for named, platform-scoped local packages; a
    // default always names its owning project (CASCADE: a deleted project drops
    // its default). The partial-unique index enforces <=1 default per project.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    isDefault: boolean("is_default").notNull().default(false),
    // M39 Stream B (ADR-113, migration 0074): the PR-to-source publish result —
    // the stable `maister/<pkg-slug>` branch last pushed and the opened PR URL.
    lastPushedBranch: text("last_pushed_branch"),
    lastPrUrl: text("last_pr_url"),
    // M39 Stream B (ADR-113, migration 0075): publish mutex. A non-null timestamp
    // means a publish of THIS package is in progress; a value older than the mutex
    // TTL is reclaimable so a crashed publish never wedges the package. Set by
    // acquirePublishLock, cleared by releasePublishLock (publish.ts critical section).
    publishingStartedAt: timestamp("publishing_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    // ADR-132 (migration 0097): durable upstream-sync intent. Persisted in a tx
    // BEFORE the first merge disk write; cleared in the SAME tx that advances
    // the fork lineage (source_install_id/source_ref). NULL = no sync in flight;
    // pending + tree state is the single crash-window discriminant.
    syncState: jsonb("sync_state").$type<LocalPackageSyncState | null>(),
    // Canonical Studio Flow creation uses this private, durable operation
    // journal across the DB + filesystem + git boundary. It is never projected
    // to a client; a non-null value blocks concurrent package mutations until
    // recovery deterministically completes or reports a conflict.
    creationState: jsonb(
      "creation_state",
    ).$type<LocalPackageCreationState | null>(),
  },
  (t) => ({
    defaultPerProject: uniqueIndex("local_packages_default_per_project")
      .on(t.projectId)
      .where(sql`${t.isDefault}`),
  }),
);

// ADR-132: the sync_state jsonb contract — {targetInstallId, targetRef,
// conflictedFiles, startedAt(ISO)}. conflictedFiles empty = "syncing";
// non-empty = "conflicted"; the resolve marker scan is the UNION of these
// files' current bytes and the dirty set (the list is a display hint).
export type LocalPackageSyncState = {
  targetInstallId: string;
  targetRef: string;
  conflictedFiles: string[];
  startedAt: string;
};

export type LocalPackageCreationState = {
  operationId: string;
  kind: "create_package_with_flow" | "add_flow";
  phase: "claimed" | "scaffolded" | "git_initialized" | "recovery_required";
  flowId: string;
  manifestHash: string;
  flowHash: string;
  originalManifestHash?: string;
  startedAt: string;
};

export type User = typeof users.$inferSelect;
export type LocalPackage = typeof localPackages.$inferSelect;
export type AccountStatus = User["accountStatus"];
export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type VerificationToken = typeof verificationTokens.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type ProjectRole = ProjectMember["role"];
export type GlobalRole = User["role"];
export type Project = typeof projects.$inferSelect;
export type PlatformAcpRunner = typeof platformAcpRunners.$inferSelect;
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
export type RunMessage = typeof runMessages.$inferSelect;
export type RunMessageInsert = typeof runMessages.$inferInsert;
// Back-compat alias (T-B1b) — historical name kept for scratch importers.
export type ScratchMessage = RunMessage;
export type ScratchAttachment = typeof scratchAttachments.$inferSelect;
export type ScratchCapabilityProfile =
  typeof scratchCapabilityProfiles.$inferSelect;
export type HitlRequest = typeof hitlRequests.$inferSelect;
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
export type ConsensusRoundVerdict = typeof consensusRoundVerdicts.$inferSelect;
export type ConsensusRoundVerdictInsert =
  typeof consensusRoundVerdicts.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type AssignmentStatus = Assignment["status"];
export type AssignmentEvent = typeof assignmentEvents.$inferSelect;
export type CapabilityImport = typeof capabilityImports.$inferSelect;
export type CapabilityImportInsert = typeof capabilityImports.$inferInsert;
export type PackageSource = typeof packageSources.$inferSelect;
export type PackageInstall = typeof packageInstalls.$inferSelect;
export type ProjectPackageAttachment =
  typeof projectPackageAttachments.$inferSelect;

// M16 (ADR-046): project-scoped API tokens (session-managed, sha256 at rest).
// Snake_case JS keys (matching the accounts table pattern) so that column
// accessors (eq(projectTokens.token_hash, ...)) and raw row keys align.
export const projectTokens = pgTable(
  "project_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    project_id: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    token_kind: text("token_kind", { enum: ["project", "user", "agent"] })
      .notNull()
      .default("project"),
    owner_user_id: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // M34 (ADR-089): per-launch ephemeral agent tokens carry the agent
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
    idxOwnerCreated: index("project_tokens_owner_created_idx").on(
      t.owner_user_id,
      t.created_at,
    ),
    projectKindProjectCheck: check(
      "project_tokens_project_kind_project_check",
      sql`${t.token_kind} != 'project' OR ${t.project_id} IS NOT NULL`,
    ),
    agentProjectCheck: check(
      "project_tokens_agent_project_check",
      sql`${t.token_kind} != 'agent' OR (${t.project_id} IS NOT NULL AND ${t.agent_id} IS NOT NULL)`,
    ),
    userOwnerCheck: check(
      "project_tokens_user_owner_check",
      sql`${t.token_kind} != 'user' OR ${t.owner_user_id} IS NOT NULL`,
    ),
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
    project_id: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
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
      enum: ["blocks", "depends_on", "parent_of", "requires", "duplicate_of"],
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
      sql`${t.kind} in ('blocks', 'depends_on', 'parent_of', 'requires', 'duplicate_of')`,
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
  // M34 (ADR-089/090): triage verdict / re-queue / dirty-watchdog quarantine.
  "triage_set",
  "triage_requeued",
  "agent_quarantined",
  "experiment_concluded",
  // ADR-140 (migration 0105): PR merged onto target — merged-only board feed
  // (closed/conflict surface via chip + webhook, not task_activity).
  "run_pr_merged",
  // M46 (ADR-142): a conclusive human Evaluation Study verdict was recorded.
  "evaluation_decided",
  // ADR-151: a mentioned agent already held an active run on the task, so the
  // summon was skipped. Written by the agent_triggers consumer (system actor),
  // idempotent by construction — see task_activity_agent_summon_uq.
  "agent_summon_suppressed",
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
      sql`${t.eventKind} in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'evaluation_decided', 'agent_summon_suppressed')`,
    ),
    // ADR-151: the structural backstop for at-least-once event redelivery —
    // the consumer inserts with onConflictDoNothing instead of reading first,
    // so there is no TOCTOU window between "already noted?" and the insert.
    uniqAgentSummon: uniqueIndex("task_activity_agent_summon_uq")
      .on(
        t.taskId,
        sql`(${t.payload}->>'agentId')`,
        sql`(${t.payload}->>'triggerEventId')`,
      )
      .where(sql`${t.eventKind} = 'agent_summon_suppressed'`),
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
      sql`${t.eventKind} in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged')`,
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
export type TaskClarificationRow = typeof taskClarifications.$inferSelect;
export type TaskClarificationInsert = typeof taskClarifications.$inferInsert;

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
      sql`${t.kind} in ('task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_answered', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed')`,
    ),
    actorTypeCheck: check(
      "domain_events_actor_type_check",
      sql`${t.actorType} in ('user', 'system', 'agent')`,
    ),
    // M43 read models resolve cut-over history by run and stale C2 claims by
    // task. Keep their JSONB predicates bounded without imposing a broad GIN
    // index on the append-only event log.
    m43CutoverRunOccurredIdx: index(
      "domain_events_m43_cutover_run_occurred_idx",
    )
      .on(t.runId, t.occurredAt)
      .where(
        sql`${t.kind} = 'run.failed' AND ${t.payload}->>'reason' = 'legacy_steps_engine_3_cutover' AND ${t.payload}->>'source' = 'upgrade_cutover'`,
      ),
    m43CutoverTaskOccurredIdx: index(
      "domain_events_m43_cutover_task_occurred_idx",
    )
      .on(t.taskId, t.occurredAt)
      .where(
        sql`${t.kind} = 'run.failed' AND ${t.payload}->>'reason' = 'legacy_steps_engine_3_cutover' AND ${t.payload}->>'source' = 'upgrade_cutover' AND ${t.taskId} IS NOT NULL`,
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
