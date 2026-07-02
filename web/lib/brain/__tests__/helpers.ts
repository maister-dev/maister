import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureEmbeddingIndex } from "@/lib/brain/embedding-index";
import {
  embeddingVersion,
  type OpenAiCompatibleClient,
} from "@/lib/brain/openai-compatible";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, the cast
// silences the type-only clash (matches the domain-events integration tests).
import * as fullSchema from "@/lib/db/schema";

// Brain integration tests need pgvector (CREATE EXTENSION vector + HNSW), so
// they run on `pgvector/pgvector:pg16`, NOT `postgres:16-alpine`. Both lineages
// are migrated (main → brain) and the test-default embedding generation index
// is created up front.
export const PGVECTOR_IMAGE = "pgvector/pgvector:pg16";
export const TEST_EMBEDDING_MODEL = "text-embedding-3-small";
export const TEST_EMBEDDING_DIMENSIONS = 1536;

export const schema = fullSchema as unknown as Record<string, any>;

export type BrainTestDb = {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: NodePgDatabase;
  prevDbUrl: string | undefined;
};

export async function startBrainTestDb(): Promise<BrainTestDb> {
  const container = await new PostgreSqlContainer(PGVECTOR_IMAGE)
    .withDatabase("maister_brain_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  // Point DB_URL at the container so the dialect guard (isBrainProvisioned reads
  // DB_URL, the same source of truth as buildClient) treats the Brain as
  // provisioned. Restored in stopBrainTestDb.
  const prevDbUrl = process.env.DB_URL;

  process.env.DB_URL = container.getConnectionUri();

  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool);

  // main → brain: brain FKs reference projects/runs/node_attempts/domain_events.
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  await migrate(db, {
    migrationsFolder: "./lib/db/brain-migrations",
    migrationsTable: "__drizzle_brain_migrations",
  });

  await ensureEmbeddingIndex(
    db,
    TEST_EMBEDDING_MODEL,
    TEST_EMBEDDING_DIMENSIONS,
  );

  return { container, pool, db, prevDbUrl };
}

export async function stopBrainTestDb(
  ctx: BrainTestDb | undefined,
): Promise<void> {
  if (ctx) {
    if (ctx.prevDbUrl === undefined) delete process.env.DB_URL;
    else process.env.DB_URL = ctx.prevDbUrl;
  }

  await ctx?.pool?.end();
  await ctx?.container?.stop();
}

// Insert a projects row (Brain enabled by default) and return its id. Only the
// columns the brain suites read are set; everything else takes its DB default.
export async function seedBrainProject(
  db: NodePgDatabase,
  overrides: { id?: string; brainEnabled?: boolean; slug?: string } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const short = id.slice(0, 8);

  await db.insert(schema.projects).values({
    id,
    slug: overrides.slug ?? `brain-proj-${short}`,
    name: "Brain Test Project",
    taskKey: `BR${randomUUID().slice(0, 6)}`.toUpperCase(),
    repoPath: `/tmp/brain-${short}`,
    maisterYamlPath: "/tmp/m.yaml",
    brainEnabled: overrides.brainEnabled ?? true,
  });

  return id;
}

// A deterministic, network-free embedding client for retain/harvest/recall
// integration tests. `vectorFor` controls similarity (default: a one-hot vector
// keyed by a hash of the text, so distinct texts are orthogonal); tests that
// exercise dedup/reinforce inject near vectors. `completeWith` supplies distill
// output.
export function fakeEmbeddingClient(opts?: {
  model?: string;
  dimensions?: number;
  vectorFor?: (text: string) => number[];
  completeWith?: (prompt: string) => string;
}): OpenAiCompatibleClient {
  const model = opts?.model ?? TEST_EMBEDDING_MODEL;
  const dimensions = opts?.dimensions ?? TEST_EMBEDDING_DIMENSIONS;
  const vectorFor =
    opts?.vectorFor ?? ((text: string) => oneHotVector(text, dimensions));

  return {
    provider: "openai_compatible",
    model,
    dimensions,
    version: embeddingVersion(model, dimensions),
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(vectorFor);
    },
    async complete(prompt: string): Promise<string> {
      return opts?.completeWith ? opts.completeWith(prompt) : "";
    },
  };
}

function oneHotVector(text: string, dimensions: number): number[] {
  const v = new Array(dimensions).fill(0);
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  v[Math.abs(h) % dimensions] = 1;

  return v;
}
