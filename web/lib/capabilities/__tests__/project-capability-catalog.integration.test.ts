// FR-B2/B3: getProjectCapabilityCatalog over a real Postgres — project skills
// (per-runner wire form) ∪ claude-only coder subagents. Switching the runner
// flips skill surface forms and toggles subagent inclusion, nothing else.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getProjectCapabilityCatalog } from "@/lib/capabilities/catalog";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = { projectId: "" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cap_catalog_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: "cap-catalog",
    name: "Cap Catalog",
    repoPath: "/tmp/cap-catalog",
    maisterYamlPath: "/tmp/cap-catalog/maister.yaml",
    taskKey: "CAP",
  });

  // A project skill supported by both claude + codex, enriched at install.
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId: fx.projectId,
    capabilityRefId: "aif-plan",
    kind: "skill",
    label: "AIF Plan",
    source: "flow-package",
    agents: ["claude", "codex"],
    material: {
      path: "skills/aif-plan",
      hasContent: true,
      description: "Plan a feature",
      argHint: "<feature>",
    },
  });

  // A coder subagent (claude-only) attached + enabled in the project.
  const agentId = "test-pkg:reviewer";

  await db.insert(schema.agents).values({
    id: agentId,
    packageName: "test-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: "reviewer",
    description: "Reviews code",
    workspace: "none",
    mode: "subagent",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: "/tmp/agents/reviewer.md",
  });
  await db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    agentId,
    projectId: fx.projectId,
    enabled: true,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("getProjectCapabilityCatalog (FR-B2/B3)", () => {
  it("claude: includes the skill as /slug AND the subagent as @name", async () => {
    const entries = await getProjectCapabilityCatalog(
      fx.projectId,
      "claude",
      db,
    );
    const skill = entries.find(
      (e) => e.kind === "skill" && e.slug === "aif-plan",
    );
    const sub = entries.find(
      (e) => e.kind === "subagent" && e.slug === "reviewer",
    );

    expect(skill).toMatchObject({
      surfaceForm: "/aif-plan",
      canonicalToken: "@skill:aif-plan",
      description: "Plan a feature",
      argHint: "<feature>",
      supported: true,
    });
    expect(sub).toMatchObject({
      surfaceForm: "@reviewer",
      canonicalToken: "@agent:reviewer",
      displayName: "reviewer",
      description: "Reviews code",
      supported: true,
    });
  });

  it("codex: flips the skill to $slug and EXCLUDES subagents", async () => {
    const entries = await getProjectCapabilityCatalog(
      fx.projectId,
      "codex",
      db,
    );
    const skill = entries.find(
      (e) => e.kind === "skill" && e.slug === "aif-plan",
    );

    expect(skill?.surfaceForm).toBe("$aif-plan");
    expect(skill?.canonicalToken).toBe("@skill:aif-plan");
    expect(entries.some((e) => e.kind === "subagent")).toBe(false);
  });
});
