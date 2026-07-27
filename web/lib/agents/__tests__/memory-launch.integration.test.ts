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

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

import { eq } from "drizzle-orm";

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
import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let root: string;

const AGENT_ID = "mem-pkg:keeper";
const SLUG = "mem-launch";
const MEMORY = "# Project notes\n\n- Tests run with `pnpm test:unit`.\n";

let projectId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_memory_launch_test",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(root, { force: true, recursive: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-memlaunch-"));
  runtimeRootMock.value = root;
  delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;

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
