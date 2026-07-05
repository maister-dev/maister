import "server-only";

import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Project Brain (ADR-122/127, Sub-projects A+B) runtime types. The brain lineage is
// HAND-AUTHORED SQL (`web/lib/db/brain-migrations/`), NOT generated from this
// module — drizzle-kit never sees it. The pgTable definitions below are a
// REFERENCE mirror of that SQL (row/kind types are derived from them; the
// brain services themselves query via raw sql`` templates today) — the SQL
// lineage is the source of truth; FKs, CHECKs, partial UNIQUEs, and indexes
// live there. Update BOTH on any column change. Brain tables are intentionally
// NOT registered in the getDb() schema (bounded context, D2) — every reader
// uses core queries, never `db.query.brainItems`.

// Untyped pgvector column (D4): the SQL type is bare `vector` (no dimension) so
// a runtime model/dimension switch never needs a schema migration — HNSW rides
// per-generation expression indexes created by `ensureEmbeddingIndex`. Pattern
// mirrors the `xid8` customType in `web/lib/db/schema.ts`. `dataType()` is
// cosmetic (no generation); `toDriver`/`fromDriver` carry pgvector's text form
// `[a,b,c]`.
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .filter((s) => s.length > 0)
      .map(Number);
  },
});

export const brainItems = pgTable("brain_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind", {
    enum: ["lesson", "observation", "state_fact", "decision", "direction"],
  }).notNull(),
  tier: text("tier").notNull().default("owned"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  status: text("status", {
    enum: ["active", "expired", "superseded"],
  })
    .notNull()
    .default("active"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  reinforcementCount: integer("reinforcement_count").notNull().default(0),
  lastReinforcedAt: timestamp("last_reinforced_at", {
    withTimezone: true,
    mode: "date",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  contentHash: text("content_hash").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  sourceRunId: text("source_run_id"),
  sourceNodeAttemptId: text("source_node_attempt_id"),
  sourceDomainEventId: bigint("source_domain_event_id", { mode: "number" }),
  sourceGateKind: text("source_gate_kind"),
  sourceRef: jsonb("source_ref").$type<BrainSourceRef | null>(),
  // `tsv` (GENERATED tsvector) is DB-owned and queried via raw SQL — omitted
  // here on purpose (a generated column must never appear in an INSERT).
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainSources = pgTable("brain_sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind", {
    enum: [
      "repo_file",
      "markdown",
      "html",
      "openapi",
      "asyncapi",
      "sql",
      "flow_yaml",
      "package_yaml",
      "agent_md",
      "code",
      "text",
    ],
  }).notNull(),
  path: text("path").notNull(),
  sourceHash: text("source_hash"),
  chunkerId: text("chunker_id").notNull(),
  chunkerVersion: text("chunker_version").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  profileManaged: boolean("profile_managed").notNull().default(false),
  lastIndexedAt: timestamp("last_indexed_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastError: jsonb("last_error").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainChunks = pgTable("brain_chunks", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  projectId: text("project_id").notNull(),
  stableId: text("stable_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  path: text("path").notNull(),
  symbol: text("symbol"),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  sourceRange: jsonb("source_range").$type<BrainSourceRange | null>(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainEmbeddings = pgTable("brain_embeddings", {
  id: text("id").primaryKey(),
  itemId: text("item_id"),
  chunkId: text("chunk_id"),
  splitOrdinal: integer("split_ordinal").notNull().default(0),
  vector: vector("vector").notNull(),
  embeddingProvider: text("embedding_provider").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingDimensions: integer("embedding_dimensions").notNull(),
  embeddingVersion: text("embedding_version").notNull(),
  sourceHash: text("source_hash").notNull(),
  contentHash: text("content_hash").notNull(),
  chunkerId: text("chunker_id"),
  chunkerVersion: text("chunker_version"),
  embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainSnapshots = pgTable("brain_snapshots", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  runId: text("run_id"),
  nodeAttemptId: text("node_attempt_id"),
  actorType: text("actor_type", {
    enum: ["user", "agent", "system"],
  }).notNull(),
  actorId: text("actor_id").notNull(),
  trigger: text("trigger", { enum: ["ambient", "explicit"] }).notNull(),
  query: text("query").notNull(),
  queryHash: text("query_hash").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  returnedItems: jsonb("returned_items")
    .$type<BrainSnapshotReturnedItem[]>()
    .notNull(),
  rankerVersion: text("ranker_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainIndexJobs = pgTable("brain_index_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  sourceId: text("source_id"),
  reason: text("reason", {
    enum: ["model_switch", "manual", "event", "chunker_upgrade"],
  }).notNull(),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed"],
  })
    .notNull()
    .default("queued"),
  progress: integer("progress").notNull().default(0),
  resumableCursor: jsonb("resumable_cursor").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// ADR-122 (F4): harvest idempotency ledger — one row per harvested domain event,
// written in retain's transaction regardless of the retain outcome so a
// re-delivered reinforce/exact-dup event never re-processes. PK (project_id,
// domain_event_id).
export const brainHarvestedEvents = pgTable(
  "brain_harvested_events",
  {
    projectId: text("project_id").notNull(),
    domainEventId: bigint("domain_event_id", { mode: "number" }).notNull(),
    harvestedAt: timestamp("harvested_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.domainEventId] }),
  }),
);

export const brainEdges = pgTable("brain_edges", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  fromRef: jsonb("from_ref").$type<BrainGraphRef>().notNull(),
  toRef: jsonb("to_ref").$type<BrainGraphRef>().notNull(),
  relation: text("relation", {
    enum: ["supports", "contradicts", "derived_from", "refines", "references"],
  }).notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  degraded: boolean("degraded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainProjectConfig = pgTable("brain_project_config", {
  projectId: text("project_id").primaryKey(),
  homeResolution: jsonb("home_resolution")
    .$type<Record<string, unknown>>()
    .notNull(),
  projectionFlowId: text("projection_flow_id"),
  autonomyPolicy: jsonb("autonomy_policy")
    .$type<Record<string, unknown>>()
    .notNull(),
  indexingProfile: text("indexing_profile", {
    enum: ["docs", "docs_source", "all"],
  })
    .notNull()
    .default("docs"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainProposalDecisionStats = pgTable(
  "brain_proposal_decision_stats",
  {
    projectId: text("project_id").notNull(),
    kind: text("kind", {
      enum: ["rule", "skill", "flow", "adr", "roadmap", "state"],
    }).notNull(),
    blastRadius: text("blast_radius", {
      enum: ["low", "medium", "high"],
    }).notNull(),
    acceptedCount: integer("accepted_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    autoDraftedCount: integer("auto_drafted_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.kind, t.blastRadius] }),
  }),
);

export const brainProposals = pgTable("brain_proposals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind", {
    enum: ["rule", "skill", "flow", "adr", "roadmap", "state"],
  }).notNull(),
  evidenceItemIds: jsonb("evidence_item_ids").$type<string[]>().notNull(),
  draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
  status: text("status", {
    enum: ["pending", "accepted", "rejected", "applied"],
  }).notNull(),
  blastRadius: text("blast_radius", {
    enum: ["low", "medium", "high"],
  }).notNull(),
  autonomyDecision: text("autonomy_decision", {
    enum: ["manual", "auto_draft"],
  }).notNull(),
  clusterHash: text("cluster_hash"),
  actor: jsonb("actor").$type<BrainProposalActor>().notNull(),
  resolution: jsonb("resolution").$type<BrainProposalResolution | null>(),
  authoredDraftId: text("authored_draft_id"),
  taskId: text("task_id"),
  runId: text("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
});

export type BrainItemRow = typeof brainItems.$inferSelect;
export type BrainItemInsert = typeof brainItems.$inferInsert;
export type BrainSourceRow = typeof brainSources.$inferSelect;
export type BrainSourceInsert = typeof brainSources.$inferInsert;
export type BrainChunkRow = typeof brainChunks.$inferSelect;
export type BrainChunkInsert = typeof brainChunks.$inferInsert;
export type BrainEmbeddingRow = typeof brainEmbeddings.$inferSelect;
export type BrainEmbeddingInsert = typeof brainEmbeddings.$inferInsert;
export type BrainSnapshotRow = typeof brainSnapshots.$inferSelect;
export type BrainSnapshotInsert = typeof brainSnapshots.$inferInsert;
export type BrainIndexJobRow = typeof brainIndexJobs.$inferSelect;
export type BrainIndexJobInsert = typeof brainIndexJobs.$inferInsert;
export type BrainProposalRow = typeof brainProposals.$inferSelect;
export type BrainProposalInsert = typeof brainProposals.$inferInsert;

export type BrainItemKind = BrainItemRow["kind"];
export type BrainItemStatus = BrainItemRow["status"];
export type BrainSourceKind = BrainSourceRow["kind"];
export type BrainIndexJobReason = BrainIndexJobRow["reason"];
export type BrainProposalKind = BrainProposalRow["kind"];
export type BrainProposalStatus = BrainProposalRow["status"];
export type BrainProposalBlastRadius = BrainProposalRow["blastRadius"];
export type BrainProposalAutonomyDecision =
  BrainProposalRow["autonomyDecision"];

export interface BrainSourceRange {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface BrainSourceRef {
  sourcePath: string;
  stableId?: string;
  sourceRange?: BrainSourceRange | null;
}

export interface BrainProposalActor {
  type: "user" | "agent" | "system";
  id: string;
}

export interface BrainProposalResolution {
  actor: BrainProposalActor;
  reason?: string;
}

export type BrainGraphRef =
  | { type: "item"; id: string }
  | {
      type: "chunk";
      id: string;
      sourceId?: string;
      sourcePath?: string;
      stableId?: string;
      symbol?: string | null;
      contentHash?: string;
    }
  | { type: "source"; id: string }
  | { type: "proposal"; id: string };

export type BrainSnapshotReturnedItem =
  | {
      tier: "owned";
      itemId: string;
      score: number;
    }
  | {
      tier: "indexed";
      chunkId: string;
      score: number;
      pointer: BrainSourceRef;
    };
