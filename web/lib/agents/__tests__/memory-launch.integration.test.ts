// ADR-152 T20/T21 — launch-time memory resolution, prompt placement, and the
// provenance pair, against real Postgres + a real temp runtime root.
//
// Scope note (plan §6.4, "one proof per fact, at the lowest layer that can
// prove it"): the composition contract is proven directly on
// `buildAgentPrompt` and `resolveAgentMemoryForLaunch` rather than by driving a
// whole supervisor session. Everything ADR-152 owns here — whether memory
// resolves, whether it is verbatim, WHERE it sits, and what happens when the
// file is absent/over-cap/unreadable — lives in those two seams. Spawning a
// session would re-prove launch mechanics that agent-driven-flow and
// launch-worktree-modes already cover.

import type { PrepareVaultAccess } from "@/lib/agent-memory-vault/store";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  parseAgentDefinition,
  renderAgentDefinition,
} from "@/lib/agents/definition";
import {
  applyAgentMemoryForLaunch,
  buildAgentPrompt,
  resolveAgentMemoryForLaunch,
} from "@/lib/agents/launch";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { agentMemoryPath, hashAgentMemory } from "@/lib/agents/memory-store";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import {
  parseAgentMemoryMutation,
  parseAgentMemoryView,
} from "@/lib/agent-memory-vault/commands";
import {
  stageProjectAgentMemory,
  stageProjectFlowMemory,
  settleMemoryInjection,
} from "@/lib/agent-memory-vault/injection";
import {
  importLegacyAgentMemory,
  type LegacyMemoryImportCommand,
} from "@/lib/agent-memory-vault/import-legacy";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import {
  ensureProjectVault,
  prepareHumanProjectVault,
  prepareProjectExecutionVault,
} from "@/lib/agent-memory-vault/project-access";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { mintAssignment } from "@/lib/execution-host/assignments";
import * as schemaModule from "@/lib/db/schema";
import { verifyToken } from "@/lib/tokens/verify";
import {
  seedLocalHost,
  seedProjectRow,
} from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let root: string;
let hostId: string;

const AGENT_ID = "mem-pkg:keeper";
const SLUG = "mem-launch";
const MEMORY = "# Project notes\n\n- Tests run with `pnpm test:unit`.\n";

let projectId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_memory_launch_test",
  });
  hostId = (await seedLocalHost(testDatabase.db)).id;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(root, { force: true, recursive: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-memlaunch-"));
  runtimeRootMock.value = root;
  delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;
  await testDatabase.pool.query("DELETE FROM agent_memory_cutover");

  await testDatabase.db.delete(schema.agentProjectLinks);
  await testDatabase.db.delete(schema.runs);
  await testDatabase.db.delete(schema.agents);
  await testDatabase.db.delete(schema.projects);

  projectId = randomUUID();
  await testDatabase.db.insert(schema.projects).values({
    id: projectId,
    slug: SLUG,
    name: "Memory launch",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: "MEML",
  });
  await testDatabase.db.insert(schema.agents).values({
    id: AGENT_ID,
    packageName: "mem-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Keeper",
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: "/tmp/keeper.md",
  });
});

it("AV-02 stages one exact initial manifest and settles it once with the prompt application receipt", async () => {
  const db = drizzle(testDatabase.pool, { schema: schemaModule });
  const run = await seedRun({ memoryEnabled: true });
  const runId = String(run.runId);
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId, reason: "launch" }),
  );
  const prepare = await vaultFixture();

  await testDatabase.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );

  const session = {
    runId,
    projectId,
    agentId: AGENT_ID,
    sessionKey: assignment.id,
  };

  await putVaultNote(prepare, "/memories/index.md", "Summary to read");
  await putVaultNote(
    prepare,
    "/memories/notes/detail.md",
    "DETAIL BODY MUST STAY OUT",
  );
  const staged = await stageProjectAgentMemory(testDatabase.db, session, false);

  expect(staged.mode).toBe("vault");
  if (staged.mode !== "vault") throw new Error("Expected a vault prompt");
  expect(staged.text).toContain("Summary to read");
  expect(staged.text).toContain("/memories/notes/detail.md");
  expect(staged.text).not.toContain("DETAIL BODY MUST STAY OUT");
  const { rows: before } = await testDatabase.pool.query(
    "SELECT agent_memory_hash FROM runs WHERE id=$1",
    [runId],
  );

  expect(before[0]?.agent_memory_hash).toBeNull();
  await putVaultNote(prepare, "/memories/notes/later.md", "new detail");
  expect(
    await stageProjectAgentMemory(testDatabase.db, session, false),
  ).toEqual(staged);
  expect(await stageProjectAgentMemory(testDatabase.db, session, true)).toEqual(
    {
      mode: "vault",
      text: null,
    },
  );
  await db.transaction((tx) =>
    settleMemoryInjection(tx, runId, assignment.id, "applied-prompt-1"),
  );
  await db.transaction((tx) =>
    settleMemoryInjection(tx, runId, assignment.id, "replayed-prompt-1"),
  );
  const { rows } = await testDatabase.pool.query(
    `SELECT r.agent_memory_hash, r.agent_memory_hash_format, i.application_state, i.application_receipt_id
     FROM runs r JOIN agent_memory_injections i ON i.run_id=r.id WHERE r.id=$1`,
    [runId],
  );

  expect(rows).toEqual([
    {
      agent_memory_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      agent_memory_hash_format: "vault-manifest-v1",
      application_state: "applied",
      application_receipt_id: "applied-prompt-1",
    },
  ]);
  await expect(
    readFile(path.join(runDirPath(root, SLUG, runId), "memory-snapshot.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

async function stageableProjectRun(runId: string, packageId: string) {
  const db = drizzle(testDatabase.pool, { schema: schemaModule });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId, reason: "launch" }),
  );

  await testDatabase.pool.query(
    `UPDATE runs SET source_agent_id=$2,activity_sort_at=now(),
       activity_timestamp_provenance='verified_creation',agent_activity_snapshot=$3::jsonb
     WHERE id=$1`,
    [
      runId,
      AGENT_ID,
      JSON.stringify({
        version: 1,
        agentId: AGENT_ID,
        packageInstallId: packageId,
        packageName: "mem-pkg",
        definitionSha256: "d".repeat(64),
      }),
    ],
  );

  return { runId, projectId, agentId: AGENT_ID, sessionKey: assignment.id };
}

async function seedMemoryPackage() {
  const packageId = randomUUID();

  await testDatabase.pool.query(
    `INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status)
     VALUES($1,'https://example.invalid/memory','mem-pkg','v1.0.0',$1,'{}','fixture','/tmp/keeper','Installed','trusted')`,
    [packageId],
  );
  await testDatabase.pool.query(
    `INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name)
     VALUES($1,$2,$1,'mem-pkg')`,
    [packageId, projectId],
  );
  await testDatabase.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
  );

  return packageId;
}

async function vaultFixture(
  sourceRestrictions: Awaited<
    ReturnType<PrepareVaultAccess>
  >["sourceRestrictions"] = [],
): Promise<PrepareVaultAccess> {
  const vaultId = await ensureProjectVault(
    testDatabase.db,
    projectId,
    AGENT_ID,
  );

  return async () => ({
    vaultId,
    principalKey: "user:operator",
    actor: { kind: "human", userId: "operator" },
    sourceProjectIds: [projectId],
    sourceRestrictions,
    writeAdmission: "apply",
    canRead: async () => true,
    capture: async () => {},
  });
}

function putVaultNote(prepare: PrepareVaultAccess, path: string, body: string) {
  return applyVaultMutation(
    testDatabase.db,
    parseAgentMemoryMutation({
      command: "create",
      path,
      file_text: body,
      requestKey: randomUUID(),
      ifHash: null,
      ifRevisionId: null,
    }),
    prepare,
    agentMemoryVaultLimits(),
  );
}

it("AV-02 ordinary sessions disclose local vault notes and captured sessions recheck guarded sources", async () => {
  const first = await seedRun({ memoryEnabled: true });
  const packageId = await seedMemoryPackage();
  const original = await stageableProjectRun(String(first.runId), packageId);
  const mounted = await seedProjectRow(testDatabase.db);
  const guarded = await vaultFixture([
    { kind: "project_context", projectId: mounted.id },
  ]);
  const local = await vaultFixture();

  await putVaultNote(guarded, "/memories/index.md", "Guarded summary");
  await putVaultNote(guarded, "/memories/notes/guarded.md", "Guarded note");
  await putVaultNote(local, "/memories/notes/local.md", "Local note");
  await testDatabase.pool.query(
    "UPDATE agent_project_links SET context_repos=$2::jsonb WHERE project_id=$1",
    [projectId, JSON.stringify([{ project: mounted.slug }])],
  );
  const ordinary = await stageProjectAgentMemory(
    testDatabase.db,
    original,
    false,
  );

  expect(ordinary).toMatchObject({
    mode: "vault",
    text: expect.stringContaining("/memories/notes/local.md"),
  });
  if (ordinary.mode !== "vault") throw new Error("Expected a vault prompt");
  expect(ordinary.text).not.toContain("Guarded summary");
  expect(ordinary.text).not.toContain("/memories/notes/guarded.md");
  expect(ordinary.text).not.toContain("Local note");

  const credential = await issueAgentRunToken({
    db: testDatabase.db,
    runId: original.runId,
    projectId,
    agentId: AGENT_ID,
  });
  const actor = await verifyToken(credential.secret, testDatabase.db);
  const read = (path: string) =>
    viewAgentMemory(
      testDatabase.db,
      parseAgentMemoryView({ command: "view", path }),
      prepareProjectExecutionVault(actor, projectId, "agent_memory:read"),
    );

  await expect(read("/memories/notes/local.md")).resolves.toMatchObject({
    content: "Local note",
  });
  await expect(read("/memories/notes/guarded.md")).rejects.toMatchObject({
    details: { reason: "agent_memory_unavailable" },
  });

  const flow = await seedRun({ runKind: "flow", attached: false });
  const flowRunId = String(flow.runId);

  await stageableProjectRun(flowRunId, packageId);
  for (const nodeType of ["ai_coding", "orchestrator"] as const) {
    const nodeAttemptId = randomUUID();

    await testDatabase.pool.query(
      "UPDATE runs SET current_step_id=$2 WHERE id=$1",
      [flowRunId, nodeType],
    );
    await testDatabase.pool.query(
      `INSERT INTO node_attempts(id,run_id,node_id,node_type,status,materialization_plan)
       VALUES($1,$2,$3,$3,'Running',$4::jsonb)`,
      [
        nodeAttemptId,
        flowRunId,
        nodeType,
        JSON.stringify({
          profileDigest: "d".repeat(64),
          resolvedRevisions: [],
          materializedFiles: [],
          enforcedClasses: [],
          instructedClasses: [],
          refusedClasses: [],
        }),
      ],
    );
    const stagedFlow = await stageProjectFlowMemory(testDatabase.db, {
      runId: flowRunId,
      nodeAttemptId,
      nodeId: nodeType,
      agentId: AGENT_ID,
    });

    expect(stagedFlow?.text).not.toContain("Guarded summary");
    expect(stagedFlow?.text).toContain("/memories/notes/local.md");
  }

  const second = await seedRun({ attached: false });
  const capturing = await stageableProjectRun(String(second.runId), packageId);

  await testDatabase.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      capturing.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  await expect(
    stageProjectAgentMemory(testDatabase.db, capturing, false),
  ).resolves.toMatchObject({
    mode: "vault",
    text: expect.stringContaining("Guarded summary"),
  });
  await testDatabase.pool.query(
    "UPDATE agent_project_links SET context_repos=NULL WHERE project_id=$1",
    [projectId],
  );
  await expect(
    stageProjectAgentMemory(testDatabase.db, capturing, true),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    stageProjectAgentMemory(testDatabase.db, capturing, false),
  ).rejects.toMatchObject({ code: "PRECONDITION" });

  await expect(
    stageProjectAgentMemory(testDatabase.db, original, true),
  ).resolves.toEqual({ mode: "vault", text: null });
});

it("AV-02 native launch bounds paths by the retained authorization budget", async () => {
  const run = await seedRun({ memoryEnabled: true });
  const packageId = await seedMemoryPackage();
  const session = await stageableProjectRun(String(run.runId), packageId);
  const prepare = await vaultFixture();
  const limit = agentMemoryVaultLimits().notes;
  const inherited = { kind: "project_context", projectId };
  const capture = {
    schemaVersion: 1,
    state: "complete",
    generation: 1,
    restrictions: [inherited],
  };

  await testDatabase.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [session.runId, JSON.stringify(capture)],
  );
  await putVaultNote(prepare, "/memories/index.md", "Authorized index");
  for (let number = 1; number < limit; number++)
    await putVaultNote(
      prepare,
      `/memories/${String(number).padStart(3, "0")}.md`,
      "",
    );

  const result = await stageProjectAgentMemory(testDatabase.db, session, false);
  const { rows } = await testDatabase.pool.query(
    `SELECT i.tree AS tree, r.knowledge_access AS capture
     FROM agent_memory_injections i JOIN runs r ON r.id=i.run_id
     WHERE i.run_id=$1`,
    [session.runId],
  );
  const [stored] = rows;

  expect(result).toMatchObject({
    mode: "vault",
    text: expect.stringContaining("More paths omitted"),
  });
  if (result.mode !== "vault") throw new Error("Expected a vault prompt");
  expect(result.text).toContain("Authorized index");
  expect(stored.tree).toMatchObject({ truncated: true });
  expect(stored.tree.paths.length).toBeGreaterThan(1);
  expect(stored.tree.paths.length).toBeLessThan(limit);
  expect(stored.tree.references).toHaveLength(stored.tree.paths.length + 1);
  expect(stored.capture.restrictions).toHaveLength(
    stored.tree.references.length + 1,
  );
  expect(stored.capture.restrictions).toEqual(
    expect.arrayContaining([inherited, ...stored.tree.references]),
  );
  expect(
    Buffer.byteLength(JSON.stringify(stored.capture.restrictions)),
  ).toBeLessThanOrEqual(65536);
}, 60_000);

it("AV-10 imports and verifies originals once, fences activation and cleans only verified sources", async () => {
  const db = drizzle(testDatabase.pool, { schema: schemaModule });
  const actor = await seedActiveUser(testDatabase.db, { role: "admin" });
  const run = await seedRun({ memoryEnabled: false });
  const missing = await seedRun({ attached: false });
  const mismatch = await seedRun({ attached: false });
  const legacyText = "legacy 🎉 bytes\n".repeat(1000);
  const snapshotText = "auditable prior input";
  const rawHash = hashAgentMemory(snapshotText);
  const command = (action: LegacyMemoryImportCommand) =>
    importLegacyAgentMemory(db, { root, command: action, actorUserId: actor });
  const seedSnapshot = async (id: string, content: string | null) => {
    const dir = runDirPath(root, SLUG, id);

    await testDatabase.pool.query(
      "UPDATE runs SET status='Done', agent_memory_hash=$2 WHERE id=$1",
      [id, rawHash],
    );
    if (content !== null) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "memory-snapshot.md"), content);
    }
  };

  await writeMemory(legacyText);
  await seedSnapshot(String(run.runId), snapshotText);
  await seedSnapshot(String(missing.runId), null);
  await seedSnapshot(String(mismatch.runId), "mismatched input");
  await command("preview");
  expect(
    await db.select().from(schemaModule.agentMemoryImportReceipts),
  ).toHaveLength(0);
  await expect(command("activate")).rejects.toMatchObject({
    code: "PRECONDITION",
  });
  await command("import");
  await command("import");
  const kept = await db.select().from(schemaModule.agentMemoryRevisions);
  const own = kept.filter(({ sourceProjectIds }) =>
    sourceProjectIds.includes(projectId),
  );

  expect(own.map((row) => row.path).sort()).toEqual([
    "/memories/index.md",
    "/memories/notes/legacy.md",
  ]);
  expect(
    own.find((row) => row.path.endsWith("/legacy.md"))?.contentSha256,
  ).toBe(hashAgentMemory(legacyText));
  await writeMemory("changed after verification");
  await expect(command("activate")).rejects.toMatchObject({
    code: "PRECONDITION",
  });
  await writeMemory(legacyText);
  await testDatabase.pool.query(
    "UPDATE runs SET status='Running' WHERE id=$1",
    [missing.runId],
  );
  await expect(command("activate")).rejects.toMatchObject({
    code: "PRECONDITION",
  });
  await testDatabase.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
    missing.runId,
  ]);
  await command("activate");
  await expect(
    testDatabase.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_memory_hash) VALUES($1,$2,'agent','Pending','agent','manual',$3)",
      [randomUUID(), projectId, rawHash],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "agent_memory_run_writer_required",
  });
  await testDatabase.pool.query(
    "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1 AND agent_id=$2",
    [projectId, AGENT_ID],
  );
  const postCutoverPath = "/memories/notes/post-cutover.md";
  const postCutoverContent = "New content resides in PostgreSQL.";

  await expect(
    applyVaultMutation(
      db,
      parseAgentMemoryMutation({
        command: "create",
        path: postCutoverPath,
        file_text: postCutoverContent,
        ifRevisionId: null,
        ifHash: null,
        requestKey: randomUUID(),
      }),
      prepareHumanProjectVault({
        userId: actor,
        slug: SLUG,
        agentId: AGENT_ID,
        action: "editSettings",
      }),
      agentMemoryVaultLimits(),
    ),
  ).resolves.toMatchObject({ status: "applied" });
  expect(await readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8")).toBe(
    legacyText,
  );

  const restartedPool = new Pool({
    connectionString: testDatabase.databaseUrl,
  });

  try {
    const reopened = drizzle(restartedPool, { schema: schemaModule });

    await expect(
      viewAgentMemory(
        reopened,
        parseAgentMemoryView({ command: "view", path: postCutoverPath }),
        prepareHumanProjectVault({
          userId: actor,
          slug: SLUG,
          agentId: AGENT_ID,
          action: "readRepoFiles",
        }),
      ),
    ).resolves.toMatchObject({ kind: "note", content: postCutoverContent });
  } finally {
    await restartedPool.end();
  }
  await command("cleanup");
  await command("cleanup");
  await expect(readFile(agentMemoryPath(SLUG, AGENT_ID))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  await expect(
    readFile(
      path.join(
        runDirPath(root, SLUG, String(mismatch.runId)),
        "memory-snapshot.md",
      ),
      "utf8",
    ),
  ).resolves.toBe("mismatched input");
  expect(
    (await db.select().from(schemaModule.runs)).map(
      (row) => row.agentMemoryHash,
    ),
  ).toEqual([rawHash, rawHash, rawHash]);
});

async function seedRun(input: {
  runKind?: "agent" | "flow";
  memoryEnabled?: boolean;
  attached?: boolean;
  // Set to model a RESUME: `startAgentSession` passes `resumeSessionId` when the
  // run already has one, so this is the signal that distinguishes the two.
  acpSessionId?: string;
}): Promise<Record<string, unknown>> {
  const runId = randomUUID();

  if (input.attached !== false) {
    await testDatabase.db.insert(schema.agentProjectLinks).values({
      id: randomUUID(),
      agentId: AGENT_ID,
      projectId,
      enabled: true,
      memoryEnabled: input.memoryEnabled ?? true,
    });
  }

  await testDatabase.db.insert(schema.runs).values({
    id: runId,
    projectId,
    agentId: AGENT_ID,
    runKind: input.runKind ?? "agent",
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
  });

  return {
    id: runId,
    runId,
    projectId,
    agentId: AGENT_ID,
    runKind: input.runKind ?? "agent",
    acpSessionId: input.acpSessionId ?? null,
  };
}

async function writeMemory(content: string): Promise<void> {
  const filePath = agentMemoryPath(SLUG, AGENT_ID);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function definition(over: { flow?: string } = {}) {
  return parseAgentDefinition(
    AGENT_ID,
    renderAgentDefinition({
      id: AGENT_ID,
      name: "Keeper",
      description: "Keeps notes.",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      memory: "enabled",
      flow: over.flow ?? null,
      prompt: "You are the keeper.",
    }),
  );
}

describe("T-C4 / REQ-C4 — memory injection at the launch seam", () => {
  it("REQ-C4 AC1 — the resolved memory is injected VERBATIM, after the config block and BEFORE the task block", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    const resolved = await resolveAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
    );

    expect(resolved).toMatchObject({ hash: hashAgentMemory(MEMORY) });

    const prompt = await buildAgentPrompt(
      testDatabase.db,
      definition(),
      run,
      resolved?.text ?? null,
    );

    expect(prompt).toContain(MEMORY.trim());

    const memoryAt = prompt.indexOf("## Agent memory");
    const personaAt = prompt.indexOf("You are the keeper.");

    expect(memoryAt).toBeGreaterThan(personaAt);
    // The task block is absent on a task-less run, so position is pinned
    // against the sections that DO exist: memory follows the persona/config
    // prologue and is the last block before any task/trigger context.
    expect(prompt.indexOf("## Trigger")).toBeGreaterThan(memoryAt);
  });

  it("REQ-C4 AC5 — the injected block carries the maintenance instruction and names memory_recall as the separate store", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    const resolved = await resolveAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
    );
    const prompt = await buildAgentPrompt(
      testDatabase.db,
      definition(),
      run,
      resolved?.text ?? null,
    );

    expect(prompt).toContain("agent_memory_write");
    expect(prompt).toContain("memory_recall");
    expect(prompt).toMatch(/compact/i);
    expect(prompt).toMatch(/KEY-N/);
  });

  it("REQ-C4 AC2 — a flow-bound agent's run never resolves memory (it diverts before this seam)", async () => {
    const run = await seedRun({ runKind: "flow", memoryEnabled: true });

    await writeMemory(MEMORY);

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });

  it("REQ-C4 — no MEMORY section is composed when nothing resolved", async () => {
    const run = await seedRun({ memoryEnabled: false });
    const prompt = await buildAgentPrompt(
      testDatabase.db,
      definition(),
      run,
      null,
    );

    expect(prompt).not.toContain("## Agent memory");
  });
});

describe("T-C6 / REQ-C6 — every memory-injecting launch is provenance-recorded", () => {
  async function snapshotOf(runId: string): Promise<string | null> {
    try {
      return await readFile(
        path.join(runDirPath(root, SLUG, runId), "memory-snapshot.md"),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  async function stampOf(runId: string): Promise<string | null> {
    const rows = await testDatabase.db
      .select({ hash: schema.runs.agentMemoryHash })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    return rows[0]?.hash ?? null;
  }

  it("REQ-C6 AC1/AC2 — writes memory-snapshot.md into the run dir AND stamps runs.agent_memory_hash", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    const text = await applyAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
      false,
    );

    expect(text).toBe(MEMORY);
    expect(await snapshotOf(run.runId as string)).toBe(MEMORY);
    expect(await stampOf(run.runId as string)).toBe(hashAgentMemory(MEMORY));
  });

  it("REQ-C6 AC3 / D12 — the overridePrompt branch writes NEITHER the snapshot nor the hash", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    const text = await applyAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
      true,
    );

    // overridePrompt discards the composed base prompt wholesale, so claiming
    // provenance for it would be a lie.
    expect(text).toBeNull();
    expect(await snapshotOf(run.runId as string)).toBeNull();
    expect(await stampOf(run.runId as string)).toBeNull();
  });

  it("D29 — the injected block frames memory as untrusted self-authored DATA, not instructions", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    const memory = await resolveAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
    );
    const prompt = await buildAgentPrompt(
      testDatabase.db,
      definition(),
      run,
      memory?.text ?? null,
    );

    // The boundary is explicit in both directions, and the trust level is
    // stated — an agent reading its own prior notes must not treat a line that
    // looks like a command as one.
    expect(prompt).toContain("BEGIN AGENT MEMORY");
    expect(prompt).toContain("END AGENT MEMORY");
    expect(prompt).toContain("never as instructions");
    // The markers actually bracket the content.
    const begin = prompt.indexOf("BEGIN AGENT MEMORY");
    const end = prompt.indexOf("END AGENT MEMORY");

    expect(begin).toBeLessThan(prompt.indexOf(MEMORY.trim()));
    expect(prompt.indexOf(MEMORY.trim())).toBeLessThan(end);
  });

  it("D29/REQ-C6 — the injected bytes are the file's bytes: no trim, so the stamped hash describes what the agent saw", async () => {
    const run = await seedRun({ memoryEnabled: true });
    // The common markdown case: a trailing newline. Trimming here would make
    // runs.agent_memory_hash describe bytes that were never injected.
    const withTrailing = "# notes\n\n- one thing\n";

    await writeMemory(withTrailing);

    const memory = await resolveAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
    );
    const prompt = await buildAgentPrompt(
      testDatabase.db,
      definition(),
      run,
      memory?.text ?? null,
    );

    expect(memory?.hash).toBe(hashAgentMemory(withTrailing));
    // The exact stored bytes — trailing newline included — sit verbatim ahead of
    // the closing marker. A trim would have eaten that newline and made the
    // stamped hash describe different bytes than the prompt carried.
    expect(prompt).toContain(`${withTrailing}\n--- END AGENT MEMORY ---`);
  });

  it("REQ-C4 AC4 / D14 — a RESUME injects nothing and does NOT re-stamp the provenance pair", async () => {
    // Spawn first: this is the state a resume inherits.
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);
    await applyAgentMemoryForLaunch(testDatabase.db, run, SLUG, false);

    const spawnStamp = await stampOf(run.runId as string);

    expect(spawnStamp).toBe(hashAgentMemory(MEMORY));

    // The agent then rewrites its memory mid-run and the session is resumed
    // (hook_trip / idle-permission both re-enter startAgentSession).
    await writeMemory("# rewritten after the spawn\n");

    const resumed = { ...run, acpSessionId: "acp-session-1" };
    const text = await applyAgentMemoryForLaunch(
      testDatabase.db,
      resumed,
      SLUG,
      false,
    );

    expect(text).toBeNull();
    // The stamp still describes what the agent STARTED from — the one question
    // the column exists to answer. Re-stamping would silently answer a different
    // one.
    expect(await stampOf(run.runId as string)).toBe(spawnStamp);
    expect(await snapshotOf(run.runId as string)).toBe(MEMORY);
  });

  it("REQ-C5 — a provenance write failure WARNs and still returns the memory: it never fails the launch", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory(MEMORY);

    // A directory where `memory-snapshot.md` must be written: atomicWriteText's
    // rename fails with EISDIR. This whole step runs inside the caller's spawn
    // try/catch, whose catch finalizes the run `Failed`.
    const snapshotPath = path.join(
      runDirPath(root, SLUG, run.runId as string),
      "memory-snapshot.md",
    );

    await mkdir(snapshotPath, { recursive: true });

    const text = await applyAgentMemoryForLaunch(
      testDatabase.db,
      run,
      SLUG,
      false,
    );

    // The agent still gets its memory; only the evidence is missing.
    expect(text).toBe(MEMORY);
    expect(await stampOf(run.runId as string)).toBeNull();
  });

  it("REQ-C6 — a launch that resolved NO memory records nothing, leaving the honest NULL seed", async () => {
    const run = await seedRun({ memoryEnabled: false });

    await writeMemory(MEMORY);

    expect(
      await applyAgentMemoryForLaunch(testDatabase.db, run, SLUG, false),
    ).toBeNull();
    expect(await snapshotOf(run.runId as string)).toBeNull();
    expect(await stampOf(run.runId as string)).toBeNull();
  });
});

describe("T-C5 / REQ-C5 — degradation never blocks a launch", () => {
  it("returns null when the axis is disabled, without touching the file", async () => {
    const run = await seedRun({ memoryEnabled: false });

    await writeMemory(MEMORY);

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });

  it("returns null when the agent is DETACHED, even though the file survives", async () => {
    const run = await seedRun({ attached: false });

    await writeMemory(MEMORY);

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });

  it("REQ-C5 AC1/AC3 — an ABSENT file degrades to null and never throws", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });

  it("REQ-C5 AC1/AC2 — an OVER-CAP file degrades to null and never throws", async () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "8";
    const run = await seedRun({ memoryEnabled: true });

    await writeMemory("x".repeat(9));

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });

  it("REQ-C5 AC1/AC2 — an UNREADABLE path (a directory) degrades to null and never throws", async () => {
    const run = await seedRun({ memoryEnabled: true });

    await mkdir(agentMemoryPath(SLUG, AGENT_ID), { recursive: true });

    await expect(
      resolveAgentMemoryForLaunch(testDatabase.db, run, SLUG),
    ).resolves.toBeNull();
  });
});
