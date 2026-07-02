import "server-only";

import {
  bigint,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Project Brain (ADR-122, Sub-project A) runtime types. The brain lineage is
// HAND-AUTHORED SQL (`web/lib/db/brain-migrations/`), NOT generated from this
// module — drizzle-kit never sees it. This file exists only so brain services
// get typed column access via the core query builder (`db.select().from(...)`);
// FKs, CHECKs, partial UNIQUEs, and indexes live in the SQL migration. Brain
// tables are intentionally NOT registered in the getDb() schema (bounded
// context, D2) — every reader uses core queries, never `db.query.brainItems`.

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
    enum: ["lesson", "observation", "state_fact"],
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
  sourceRunId: text("source_run_id"),
  sourceNodeAttemptId: text("source_node_attempt_id"),
  sourceDomainEventId: bigint("source_domain_event_id", { mode: "number" }),
  sourceGateKind: text("source_gate_kind"),
  // `tsv` (GENERATED tsvector) is DB-owned and queried via raw SQL — omitted
  // here on purpose (a generated column must never appear in an INSERT).
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainEmbeddings = pgTable("brain_embeddings", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull(),
  splitOrdinal: integer("split_ordinal").notNull().default(0),
  vector: vector("vector").notNull(),
  embeddingProvider: text("embedding_provider").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingDimensions: integer("embedding_dimensions").notNull(),
  embeddingVersion: text("embedding_version").notNull(),
  sourceHash: text("source_hash").notNull(),
  contentHash: text("content_hash").notNull(),
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
    .$type<Array<{ itemId: string; score: number }>>()
    .notNull(),
  rankerVersion: text("ranker_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const brainIndexJobs = pgTable("brain_index_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  reason: text("reason", {
    enum: ["model_switch", "manual"],
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

export type BrainItemRow = typeof brainItems.$inferSelect;
export type BrainItemInsert = typeof brainItems.$inferInsert;
export type BrainEmbeddingRow = typeof brainEmbeddings.$inferSelect;
export type BrainEmbeddingInsert = typeof brainEmbeddings.$inferInsert;
export type BrainSnapshotRow = typeof brainSnapshots.$inferSelect;
export type BrainSnapshotInsert = typeof brainSnapshots.$inferInsert;
export type BrainIndexJobRow = typeof brainIndexJobs.$inferSelect;
export type BrainIndexJobInsert = typeof brainIndexJobs.$inferInsert;

export type BrainItemKind = BrainItemRow["kind"];
export type BrainItemStatus = BrainItemRow["status"];
