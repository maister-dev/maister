import type { SupervisorDiagnostics } from "@/lib/supervisor-client";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reconcilePlatformRunners } from "../native-defaults";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;
const { platformAcpRunners, platformRouterSidecars, platformRuntimeSettings } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("native_defaults_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // FK: platform_runtime_settings.default_runner_id -> platform_acp_runners.id,
  // so clear the singleton before the runners.
  await db.delete(platformRuntimeSettings);
  await db.delete(platformAcpRunners);
  await db.delete(platformRouterSidecars);
});

function diagnostics(available: AdapterId[]): SupervisorDiagnostics {
  return {
    status: "ready",
    version: "test",
    checkedAt: new Date().toISOString(),
    adapters: ADAPTER_IDS.map((id) => ({
      id,
      binary: `${id}-acp`,
      source: "path",
      path: `/usr/bin/${id}`,
      available: available.includes(id),
      version: "1.0.0",
      error: null,
      smoke: {
        status: "ok",
        reason: null,
        checkedAt: null,
        protocolVersion: 1,
      },
    })),
    sidecars: [{ id: "ccr-default", kind: "ccr", state: "idle" }],
    envRefs: [
      { name: "GEMINI_API_KEY", present: true },
      { name: "ZAI_API_KEY", present: false },
    ],
  } as unknown as SupervisorDiagnostics;
}

async function runners(): Promise<any[]> {
  return db.select().from(platformAcpRunners);
}

describe("reconcilePlatformRunners (integration)", () => {
  it("materializes native defaults only for available adapters and recomputes readiness", async () => {
    await reconcilePlatformRunners({
      db,
      diagnostics: diagnostics(["claude", "codex"]),
    });

    const rows = await runners();
    const ids = rows.map((row) => row.id).sort();

    expect(ids).toEqual(["claude-code", "codex-openai"]);

    const claude = rows.find((row) => row.id === "claude-code");

    // Native anthropic readiness = binary available, no credential check.
    expect(claude.readinessStatus).toBe("Ready");
    expect(claude.readinessReasons).toEqual([]);
  });

  it("does not materialize a default for an unavailable adapter", async () => {
    await reconcilePlatformRunners({
      db,
      diagnostics: diagnostics(["claude"]),
    });

    const ids = (await runners()).map((row) => row.id);

    expect(ids).toEqual(["claude-code"]);
  });

  it("sets the platform-default singleton to the first Ready native default when absent", async () => {
    await reconcilePlatformRunners({
      db,
      diagnostics: diagnostics(["codex", "claude"]),
    });

    const settings = await db
      .select()
      .from(platformRuntimeSettings)
      .where(eq(platformRuntimeSettings.id, "singleton"));

    // Deterministic adapter preference: claude > codex.
    expect(settings[0]?.defaultRunnerId).toBe("claude-code");
  });

  it("never auto-deletes a materialized runner when its adapter goes unavailable; readiness drops to NotReady", async () => {
    await reconcilePlatformRunners({
      db,
      diagnostics: diagnostics(["claude"]),
    });
    await reconcilePlatformRunners({ db, diagnostics: diagnostics([]) });

    const claude = (await runners()).find((row) => row.id === "claude-code");

    expect(claude).toBeDefined();
    expect(claude.readinessStatus).toBe("NotReady");
    expect(claude.readinessReasons.length).toBeGreaterThan(0);
  });

  it("is a no-op when diagnostics are unavailable — preserves last-known readiness and writes no singleton", async () => {
    await db.insert(platformAcpRunners).values({
      id: "claude-code",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
      sidecarId: null,
      enabled: true,
      readinessStatus: "Ready",
      readinessReasons: [],
    });

    await reconcilePlatformRunners({ db, diagnostics: null });

    const claude = (await runners()).find((row) => row.id === "claude-code");

    expect(claude.readinessStatus).toBe("Ready");

    const settings = await db.select().from(platformRuntimeSettings);

    expect(settings).toHaveLength(0);
  });
});
