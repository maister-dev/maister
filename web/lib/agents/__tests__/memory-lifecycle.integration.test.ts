// ADR-152 — agent memory lifecycle against real Postgres. This file owns the
// cases no single-phase test can reach: the applied migration shape, the
// attach-time definition default, and (from T27) the cross-run round trip.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

import {
  parseAgentDefinition,
  renderAgentDefinition,
} from "@/lib/agents/definition";
import {
  applyAgentMemoryForLaunch,
  buildAgentPrompt,
  resolveAgentMemoryForLaunch,
} from "@/lib/agents/launch";
import {
  agentMemoryPath,
  readAgentMemoryRaw,
  writeAgentMemory,
} from "@/lib/agents/memory-store";
import { attachAgent, detachAgent } from "@/lib/agents/project-links";
import * as schemaModule from "@/lib/db/schema";
import {
  applyMainMigration,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let runtimeRootDir: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_memory_lifecycle_test",
  });
  runtimeRootDir = await mkdtemp(path.join(os.tmpdir(), "maister-memlife-"));
  runtimeRootMock.value = runtimeRootDir;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(runtimeRootDir, { force: true, recursive: true });
});

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function columnOf(
  db: StartedPostgresTestDb["db"],
  table: string,
  column: string,
): Promise<ColumnRow | undefined> {
  const result = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);

  return (result.rows as unknown as ColumnRow[])[0];
}

// One self-contained project + package + pinned agent definition. `memory` is
// what varies; `writeDefinition: false` reproduces pin divergence (the package
// is attached but its maister-agents/<stem>.md is missing), which is what makes
// resolveEffectiveAgentDefinition throw.
async function seedAttachable(input: {
  memory?: "none" | "enabled";
  writeDefinition?: boolean;
}): Promise<{ projectId: string; agentId: string; pkgRoot: string }> {
  const db = testDatabase.db;
  const pool = testDatabase.pool;
  const suffix = randomUUID().slice(0, 8);
  const packageName = `mem-pkg-${suffix}`;
  const stem = "keeper";
  const agentId = `${packageName}:${stem}`;
  const projectId = randomUUID();
  const pkgRoot = await mkdtemp(path.join(os.tmpdir(), "maister-mem-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `mem-${suffix}`,
    name: `Memory ${suffix}`,
    repoPath: `/tmp/mem-${suffix}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: `M${suffix.toUpperCase()}`,
  });
  await db.insert(schema.agents).values({
    id: agentId,
    packageName,
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Keeper",
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: path.join(pkgRoot, "maister-agents", `${stem}.md`),
  });

  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, $2, 'github.com/acme/mem', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $3, 'Installed')`,
    [revisionId, packageName, pkgRoot],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, $3, 'github.com/acme/mem', 'v1.0.0', $4,
             '{}'::jsonb, 1, $5, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, packageName, pkgRoot, revisionId],
  );

  if (input.writeDefinition !== false) {
    await mkdir(path.join(pkgRoot, "maister-agents"), { recursive: true });
    await writeFile(
      path.join(pkgRoot, "maister-agents", `${stem}.md`),
      renderAgentDefinition({
        id: agentId,
        name: "Keeper",
        description: "Keeps notes across runs.",
        workspace: "none",
        mode: "session",
        triggers: ["manual"],
        riskTier: "read_only",
        memory: input.memory ?? "none",
        prompt: "You are the keeper.",
      }),
      "utf8",
    );
  }

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/mem', $2, 'v1.0.0', 'rev-pkg-1',
             '{}'::jsonb, 'digest', $3, 'Installed', 'trusted')`,
    [packageInstallId, packageName, pkgRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), projectId, packageInstallId, packageName],
  );

  return { projectId, agentId, pkgRoot };
}

async function linkRow(projectId: string, agentId: string) {
  const rows = await testDatabase.db
    .select()
    .from(schema.agentProjectLinks)
    .where(
      and(
        eq(schema.agentProjectLinks.projectId, projectId),
        eq(schema.agentProjectLinks.agentId, agentId),
      ),
    );

  return rows[0];
}

describe("T-C2b / REQ-C2 — the attach-time memory default is applied SERVER-side", () => {
  it("REQ-C2 AC3 — a bare attach with NO follow-up PATCH lands memory_enabled=true for `memory: enabled`", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        true,
      );
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("REQ-C2 AC3 — the same bare attach lands memory_enabled=false for `memory: none`", async () => {
    const fx = await seedAttachable({ memory: "none" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        false,
      );
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("REQ-C2 AC4 — the stored value is EFFECTIVE: a package upgrade never re-enables what an operator turned off", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );
      // The operator turns it off.
      await testDatabase.db
        .update(schema.agentProjectLinks)
        .set({ memoryEnabled: false })
        .where(
          and(
            eq(schema.agentProjectLinks.projectId, fx.projectId),
            eq(schema.agentProjectLinks.agentId, fx.agentId),
          ),
        );

      // A package upgrade republishes the SAME `memory: enabled` definition.
      await writeFile(
        path.join(fx.pkgRoot, "maister-agents", "keeper.md"),
        renderAgentDefinition({
          id: fx.agentId,
          name: "Keeper",
          description: "Keeps notes across runs (v2).",
          workspace: "none",
          mode: "session",
          triggers: ["manual"],
          riskTier: "read_only",
          memory: "enabled",
          prompt: "You are the keeper, v2.",
        }),
        "utf8",
      );

      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        false,
      );
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("D21' — when the effective definition cannot be resolved, the ATTACH FAILS and no link row is written", async () => {
    const fx = await seedAttachable({ writeDefinition: false });

    try {
      await expect(
        attachAgent(
          { projectId: fx.projectId, agentId: fx.agentId },
          testDatabase.db,
        ),
      ).rejects.toThrow();

      // The alternative — silently landing `false` — is a "looks configured but
      // isn't" trap, which is exactly what D21' rejects.
      expect(await linkRow(fx.projectId, fx.agentId)).toBeUndefined();
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });
});

describe("T-C1 / REQ-C1 — migration 0122 applies additively", () => {
  it("lands memory_enabled NOT NULL DEFAULT false and agent_memory_hash nullable on a FRESH database", async () => {
    const memoryEnabled = await columnOf(
      testDatabase.db,
      "agent_project_links",
      "memory_enabled",
    );
    const agentMemoryHash = await columnOf(
      testDatabase.db,
      "runs",
      "agent_memory_hash",
    );

    expect(memoryEnabled).toMatchObject({
      column_name: "memory_enabled",
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    });
    expect(agentMemoryHash).toMatchObject({
      column_name: "agent_memory_hash",
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("applies cleanly on a database already at 0121 — the upgrade path, not just the fresh one", async () => {
    const at0121 = await startMainPostgresTestDbUpTo(
      { databaseName: "agent_memory_upgrade_test" },
      "0121_agent_mention_summons",
    );

    try {
      const before = await columnOf(
        at0121.db,
        "agent_project_links",
        "memory_enabled",
      );

      expect(before).toBeUndefined();

      await applyMainMigration(at0121.db, "0122_agent_memory_files");

      const memoryEnabled = await columnOf(
        at0121.db,
        "agent_project_links",
        "memory_enabled",
      );
      const agentMemoryHash = await columnOf(
        at0121.db,
        "runs",
        "agent_memory_hash",
      );

      expect(memoryEnabled?.is_nullable).toBe("NO");
      expect(memoryEnabled?.column_default).toBe("false");
      expect(agentMemoryHash?.is_nullable).toBe("YES");
    } finally {
      await at0121.stop();
    }
  }, 180_000);
});

// --- T27: the cases that span TWO runs or TWO lifecycle events ---------------

// A run row shaped exactly as a launch produces it. `triggerSource` is what a
// mention summon stamps (ADR-151 keeps the source `domain_event`), and memory
// resolution keys on (agentId, projectId, run_kind) — never on the trigger — so
// this is the honest shape for the loop acceptance.
async function seedAgentRun(
  projectId: string,
  agentId: string,
  triggerSource: "manual" | "domain_event" = "manual",
): Promise<Record<string, unknown>> {
  const runId = randomUUID();

  await testDatabase.db.insert(schema.runs).values({
    id: runId,
    projectId,
    agentId,
    runKind: "agent",
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    triggerSource,
  });

  return { id: runId, runId, projectId, agentId, runKind: "agent" };
}

function keeperDefinition(agentId: string) {
  return parseAgentDefinition(
    agentId,
    renderAgentDefinition({
      id: agentId,
      name: "Keeper",
      description: "Keeps notes across runs.",
      workspace: "none",
      mode: "session",
      triggers: ["manual", "domain_event"],
      riskTier: "read_only",
      memory: "enabled",
      prompt: "You are the keeper.",
    }),
  );
}

async function slugOf(projectId: string): Promise<string> {
  const rows = await testDatabase.db
    .select({ slug: schema.projects.slug })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  return rows[0].slug as string;
}

describe("T27 — the cross-run loop this feature exists for", () => {
  it("T27.2 — content written by run N is injected VERBATIM into run N+1's prompt", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);
      const notes =
        "# Notes from run N\n\n- The build script is `pnpm build`.\n";

      // Run N writes.
      const runN = await seedAgentRun(fx.projectId, fx.agentId);

      await writeAgentMemory(slug, fx.agentId, notes);
      expect(runN).toBeTruthy();

      // Run N+1 launches and reads it back.
      const runNext = await seedAgentRun(fx.projectId, fx.agentId);
      const text = await applyAgentMemoryForLaunch(
        testDatabase.db,
        runNext,
        slug,
        false,
      );
      const prompt = await buildAgentPrompt(
        testDatabase.db,
        keeperDefinition(fx.agentId),
        runNext,
        text,
      );

      expect(text).toBe(notes);
      expect(prompt).toContain(notes.trim());
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("T27.3 — THE LOOP ACCEPTANCE: a mention-summoned run sees memory written by a previous run of the same attachment", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);
      const learned = "The reviewer prefers small diffs. See MAI-12.";

      await seedAgentRun(fx.projectId, fx.agentId);
      await writeAgentMemory(slug, fx.agentId, learned);

      // The ADR-151 summon path: run_kind='agent', trigger_source='domain_event'.
      const summoned = await seedAgentRun(
        fx.projectId,
        fx.agentId,
        "domain_event",
      );
      const prompt = await buildAgentPrompt(
        testDatabase.db,
        keeperDefinition(fx.agentId),
        summoned,
        await applyAgentMemoryForLaunch(testDatabase.db, summoned, slug, false),
      );

      expect(prompt).toContain(learned);
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("T27.5 / REQ-C5+C8 — with memory OFF there is no MEMORY section AND the write gate refuses", async () => {
    const fx = await seedAttachable({ memory: "none" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);

      await writeAgentMemory(slug, fx.agentId, "written out of band");

      const run = await seedAgentRun(fx.projectId, fx.agentId);
      const text = await applyAgentMemoryForLaunch(
        testDatabase.db,
        run,
        slug,
        false,
      );
      const prompt = await buildAgentPrompt(
        testDatabase.db,
        keeperDefinition(fx.agentId),
        run,
        text,
      );

      expect(text).toBeNull();
      expect(prompt).not.toContain("## Agent memory");
      // The same link flag the ext route consults — both halves of the
      // conjunction refuse together.
      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        false,
      );
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });
});

describe("T-C10 / REQ-C10 — attachment lifecycle semantics", () => {
  it("detach makes memory INERT while the file SURVIVES untouched", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);

      await writeAgentMemory(slug, fx.agentId, "survives detach");

      await detachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const run = await seedAgentRun(fx.projectId, fx.agentId);

      // Inert: nothing resolves for a detached agent...
      await expect(
        resolveAgentMemoryForLaunch(testDatabase.db, run, slug),
      ).resolves.toBeNull();
      // ...but the bytes are still on disk.
      expect((await readAgentMemoryRaw(slug, fx.agentId)).content).toBe(
        "survives detach",
      );
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("re-attach REVIVES the surviving file and re-applies the DEFINITION default", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);

      await writeAgentMemory(slug, fx.agentId, "still here");
      await detachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const run = await seedAgentRun(fx.projectId, fx.agentId);

      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        true,
      );
      await expect(
        resolveAgentMemoryForLaunch(testDatabase.db, run, slug),
      ).resolves.toMatchObject({ text: "still here" });
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("D19 SURPRISE — re-attaching a `memory: none` agent revives the file but leaves it INERT", async () => {
    const fx = await seedAttachable({ memory: "none" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);

      await writeAgentMemory(slug, fx.agentId, "orphaned notes");
      // An operator had turned it ON before detaching...
      await testDatabase.db
        .update(schema.agentProjectLinks)
        .set({ memoryEnabled: true })
        .where(eq(schema.agentProjectLinks.projectId, fx.projectId));
      await detachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const run = await seedAgentRun(fx.projectId, fx.agentId);

      // ...but re-attach re-applies the DEFINITION default, not the previous
      // operator choice. The file is intact; it is simply not used. Correct by
      // construction and deliberately surprising, hence pinned here.
      expect((await linkRow(fx.projectId, fx.agentId))?.memoryEnabled).toBe(
        false,
      );
      expect((await readAgentMemoryRaw(slug, fx.agentId)).content).toBe(
        "orphaned notes",
      );
      await expect(
        resolveAgentMemoryForLaunch(testDatabase.db, run, slug),
      ).resolves.toBeNull();
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });

  it("REQ-C3 AC6 — a package RE-PIN preserves the file: the path is keyed by qualified id, never by revision", async () => {
    const fx = await seedAttachable({ memory: "enabled" });

    try {
      await attachAgent(
        { projectId: fx.projectId, agentId: fx.agentId },
        testDatabase.db,
      );

      const slug = await slugOf(fx.projectId);
      const before = agentMemoryPath(slug, fx.agentId);

      await writeAgentMemory(slug, fx.agentId, "across versions");

      // Re-pin: a new package revision at a NEW installed path.
      await testDatabase.db
        .update(schema.packageInstalls)
        .set({ versionLabel: "v2.0.0", resolvedRevision: "rev-pkg-2" })
        .where(eq(schema.packageInstalls.name, fx.agentId.split(":")[0]));

      expect(agentMemoryPath(slug, fx.agentId)).toBe(before);
      expect((await readAgentMemoryRaw(slug, fx.agentId)).content).toBe(
        "across versions",
      );
      expect(before).not.toContain("v1.0.0");
      expect(before).not.toContain("v2.0.0");
    } finally {
      await rm(fx.pkgRoot, { force: true, recursive: true });
    }
  });
});
