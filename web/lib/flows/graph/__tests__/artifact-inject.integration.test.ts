import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { closeDb } from "@/lib/db/client";
import {
  artifactContentToTemplateText,
  capForInline,
  resolveArtifactContent,
} from "@/lib/flows/graph/artifact-content";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_inject")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await pool?.end();
  await container?.stop();
});

type Seeded = {
  runId: string;
  slug: string;
  runtimeRoot: string;
  worktreePath: string;
};

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "g",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest,
    schemaVersion: 1,
    installedPath: "/tmp/flows/g",
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "fix the bug",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot, worktreePath };
}

async function runDirOf(seeded: Seeded): Promise<string> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });

  return dir;
}

async function seedArtifactRow(
  runId: string,
  artifactDefId: string,
  kind: string,
  producer: string,
  locator: unknown,
): Promise<void> {
  await db.insert(schema.artifactInstances).values({
    id: randomUUID(),
    runId,
    artifactDefId,
    nodeId: "seed",
    attempt: 1,
    kind,
    producer,
    locator,
    validity: "current",
  });
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempt(
  runId: string,
  nodeId: string,
): Promise<NodeAttempt | undefined> {
  const rows = (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];

  return rows.find((a) => a.nodeId === nodeId);
}

function makeAgentSupervisor(): SupervisorApi & {
  createSession: ReturnType<typeof vi.fn>;
} {
  async function* stream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    } as SupervisorEvent;
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 2,
      exitCode: 0,
    } as SupervisorEvent;
  }

  const createSession = vi.fn(async () => ({
    sessionId: "sup-1",
    pid: 1,
    acpSessionId: "acp-1",
  }));

  return {
    createSession: createSession as unknown as SupervisorApi["createSession"],
    deleteSession: (async () =>
      undefined) as unknown as SupervisorApi["deleteSession"],
    sendPrompt: (async () => ({
      stopReason: "end_turn" as const,
    })) as unknown as SupervisorApi["sendPrompt"],
    streamSession: (() =>
      stream()) as unknown as SupervisorApi["streamSession"],
    cancelPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  } as unknown as SupervisorApi & { createSession: ReturnType<typeof vi.fn> };
}

// A supervisor that records every resolved prompt handed to sendPrompt and
// streams a `pass` verdict so a blocking ai_judgment gate clears (letting the
// node finish). Used to assert the GATE prompt rendered the injected body.
function makeCapturingSupervisor(): {
  api: SupervisorApi;
  prompts: string[];
} {
  const prompts: string[] = [];

  async function* stream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: '{"verdict":"pass"}' },
      },
    } as SupervisorEvent;
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 2,
      exitCode: 0,
    } as SupervisorEvent;
  }

  const api = {
    createSession: (async () => ({
      sessionId: "sup-1",
      pid: 1,
      acpSessionId: "acp-1",
    })) as unknown as SupervisorApi["createSession"],
    deleteSession: (async () =>
      undefined) as unknown as SupervisorApi["deleteSession"],
    sendPrompt: (async (_sessionId: string, args: { prompt: string }) => {
      prompts.push(args.prompt);

      return { stopReason: "end_turn" as const };
    }) as unknown as SupervisorApi["sendPrompt"],
    streamSession: (() =>
      stream()) as unknown as SupervisorApi["streamSession"],
    cancelPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  } as unknown as SupervisorApi;

  return { api, prompts };
}

const COMPAT = { engine_min: "2.2.0" };

describe("runGraph — artifact body injection (ADR-120, P2)", () => {
  it("inline:true auto-appends an <artifact> XML block carrying the resolved file body", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "produce",
          type: "cli",
          action: { command: "echo ok" },
          output: {
            produces: [{ id: "plan", kind: "plan", path: "plan.txt" }],
          },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Implement per the plan." },
          input: {
            requires: [{ artifact: "plan", kind: "plan", inline: true }],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const dir = await runDirOf(seeded);

    await writeFile(join(dir, "plan.txt"), "PLAN-BODY-123", "utf8");

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeAgentSupervisor(),
    });

    const consume = await getAttempt(seeded.runId, "consume");
    const prompt = consume?.resolvedPrompt ?? "";

    expect(prompt).toContain('<artifact id="plan" kind="plan">');
    expect(prompt).toContain("PLAN-BODY-123");
    expect(prompt).toContain("</artifact>");
  }, 120_000);

  it("dedup: a manual {{content}} ref + inline:true for the same id injects the body exactly once", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "produce",
          type: "cli",
          action: { command: "echo ok" },
          output: {
            produces: [{ id: "plan", kind: "plan", path: "plan.txt" }],
          },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Plan body: {{ artifacts.plan.content }}" },
          input: {
            requires: [{ artifact: "plan", kind: "plan", inline: true }],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const dir = await runDirOf(seeded);

    await writeFile(join(dir, "plan.txt"), "UNIQUE-BODY-XYZ", "utf8");

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeAgentSupervisor(),
    });

    const consume = await getAttempt(seeded.runId, "consume");
    const prompt = consume?.resolvedPrompt ?? "";
    const occurrences = prompt.split("UNIQUE-BODY-XYZ").length - 1;

    expect(occurrences).toBe(1);
    // The inline auto-append was skipped (manual placement wins) → no XML block.
    expect(prompt).not.toContain('<artifact id="plan"');
  }, 120_000);

  // gate-verdict / hitl-response carry their payload in a SECOND table
  // (gate_results.verdict / hitl_requests.response), so the resolver's runId-scoped
  // join is exercised here against REAL Postgres (the fake-db unit test cannot
  // catch a drizzle query/column mismatch). The full D11 pipeline
  // (resolveArtifactContent → artifactContentToTemplateText → capForInline) is run
  // directly: a runGraph pass would trip the in-flight guard because the FK forces
  // a pre-seeded node_attempts row (Codex #4 is the json→pretty proof, which this
  // gives end-to-end against the live DB).
  it("gate-verdict / hitl-response resolve to pretty-printed JSON via the live DB (not [object Object])", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "x" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    const nodeAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId: seeded.runId,
      nodeId: "seed",
      nodeType: "judge",
      attempt: 1,
      status: "Succeeded",
    });
    const gateResultId = randomUUID();

    await db.insert(schema.gateResults).values({
      id: gateResultId,
      runId: seeded.runId,
      nodeAttemptId,
      gateId: "g1",
      kind: "ai_judgment",
      status: "passed",
      verdict: { verdict: "pass", confidence: 0.9 },
    });
    const hitlRequestId = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId: seeded.runId,
      stepId: "seed",
      kind: "human_review",
      prompt: "approve?",
      response: { decision: "approve", note: "lgtm" },
    });

    const ctx = {
      worktreePath: seeded.worktreePath,
      projectSlug: seeded.slug,
      runId: seeded.runId,
      runtimeRoot: seeded.runtimeRoot,
      db,
    };

    const verdict = await resolveArtifactContent(
      { locator: { kind: "gate-verdict", gateResultId } },
      ctx,
    );
    const verdictText = capForInline(
      artifactContentToTemplateText(verdict, "v"),
    ).text;

    expect(verdict.kind).toBe("json");
    expect(verdictText).not.toContain("[object Object]");
    expect(verdictText).toContain('"verdict": "pass"');

    const response = await resolveArtifactContent(
      { locator: { kind: "hitl-response", hitlRequestId } },
      ctx,
    );
    const responseText = capForInline(
      artifactContentToTemplateText(response, "h"),
    ).text;

    expect(response.kind).toBe("json");
    expect(responseText).toContain('"decision": "approve"');

    // runId-scoping: the same locator resolved under a DIFFERENT run finds nothing.
    const cross = await resolveArtifactContent(
      { locator: { kind: "gate-verdict", gateResultId } },
      { ...ctx, runId: randomUUID() },
    );

    expect(cross.kind).toBe("notfound");
  }, 120_000);

  it("mustache re-render invariant: an inline body containing {{ }} is injected verbatim", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Body: {{ artifacts.x.content }}" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await seedArtifactRow(seeded.runId, "x", "plan", "runner", {
      kind: "inline",
      text: "see {{ task.prompt }} for details",
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeAgentSupervisor(),
    });

    const consume = await getAttempt(seeded.runId, "consume");
    const prompt = consume?.resolvedPrompt ?? "";

    // The braces in the body are NOT re-resolved against the context.
    expect(prompt).toContain("see {{ task.prompt }} for details");
  }, 120_000);

  it("an ai_judgment gate prompt is rendered with the injected artifact body (shared node context)", async () => {
    // The body is referenced ONLY in the gate prompt — NOT in the action prompt —
    // so a captured prompt containing it proves the gate path rendered through the
    // same node context (collectContentArtifactIds scans gate prompts; runNodeGates
    // feeds the node context to the gate's renderStrict — no gates-exec edit).
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Do the work." },
          pre_finish: {
            gates: [
              {
                id: "judge-gate",
                kind: "ai_judgment",
                mode: "blocking",
                prompt:
                  "Review against the plan:\n{{ artifacts.gateart.content }}\nVerdict?",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await seedArtifactRow(seeded.runId, "gateart", "plan", "runner", {
      kind: "inline",
      text: "GATE-ONLY-BODY-789",
    });

    const { api, prompts } = makeCapturingSupervisor();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    // The gate passed → node finished → run reached Review.
    expect((await getRun(seeded.runId)).status).toBe("Review");
    // The action prompt never referenced the body; only the gate prompt did.
    expect(prompts.some((p) => p.includes("Do the work."))).toBe(true);
    expect(prompts.some((p) => p.includes("GATE-ONLY-BODY-789"))).toBe(true);
  }, 120_000);

  it("a skill_check gate COMMAND is rendered with the injected body (Codex #1 — executor field)", async () => {
    // skill_check renders gate.command (not prompt) via runAgentStep, so the scan
    // must collect from command. The body is referenced ONLY in the gate command —
    // a captured prompt containing it proves the false-negative fix end-to-end.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Do the work." },
          pre_finish: {
            gates: [
              {
                id: "skill-gate",
                kind: "skill_check",
                mode: "blocking",
                command: "verify {{ artifacts.skillart.content }}",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await seedArtifactRow(seeded.runId, "skillart", "plan", "runner", {
      kind: "inline",
      text: "SKILL-CMD-BODY-456",
    });

    const { api, prompts } = makeCapturingSupervisor();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(prompts.some((p) => p.includes("SKILL-CMD-BODY-456"))).toBe(true);
  }, 120_000);

  it("a POLICY-SKIPPED gate with a gone artifact ref does NOT fail the node (Codex #1)", async () => {
    // A blocking command_check whose command references a CURRENT file artifact
    // with a GONE payload. Under checks=skip the gate is never evaluated, so its
    // refs are EXCLUDED from the pre-action resolution set — the gone payload is
    // never resolved and cannot fail the node.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Do the work." },
          pre_finish: {
            gates: [
              {
                id: "skip-gate",
                kind: "command_check",
                mode: "blocking",
                command: "check {{ artifacts.goneart.content }}",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    // Current row, but the file was never written → payload is gone.
    await seedArtifactRow(seeded.runId, "goneart", "log", "runner", {
      kind: "file",
      path: "vanished.log",
    });
    // Execution policy checks=skip → the non-review command_check is skipped.
    await db
      .update(schema.runs)
      .set({
        executionPolicy: {
          preset: "supervised",
          overrides: { checks: "skip" },
        },
      })
      .where(eq(schema.runs.id, seeded.runId));

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeAgentSupervisor(),
    });

    const consume = await getAttempt(seeded.runId, "consume");

    // The skipped gate's gone ref did NOT fail the node before spawn.
    expect(consume?.status).not.toBe("Failed");
    expect((await getRun(seeded.runId)).status).toBe("Review");
  }, 120_000);

  it("a NON-skipped gate with a gone ref fails the node cleanly BEFORE spawn (Codex #1)", async () => {
    // Same gate, but checks stays strict (default) → the gate WILL run. Its gone
    // ref is resolved strictly and fails the node with a controlled CONFIG before
    // the agent spawns — NOT an uncontrolled mid-gate render throw that would leave
    // a half-created gate row.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Do the work." },
          pre_finish: {
            gates: [
              {
                id: "strict-gate",
                kind: "command_check",
                mode: "blocking",
                command: "check {{ artifacts.goneart.content }}",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await seedArtifactRow(seeded.runId, "goneart", "log", "runner", {
      kind: "file",
      path: "vanished.log",
    });

    const api = makeAgentSupervisor();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const consume = await getAttempt(seeded.runId, "consume");

    expect(consume?.status).toBe("Failed");
    expect(consume?.errorCode).toBe("CONFIG");
    // Controlled pre-spawn failure — the agent was never created.
    expect(api.createSession).not.toHaveBeenCalled();
    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 120_000);

  it("a NON-skipped gate referencing an ABSENT-current artifact fails as a controlled gate, no leaked running row (Codex)", async () => {
    // The gate references `{{ artifacts.missing.content }}` for an id with NO
    // current row (never produced). That id is unset in context, so the gate's
    // renderStrict throws at gate execution. The per-gate guard MUST convert that
    // throw into a controlled failed gate — never leave a `gate_results` row stuck
    // `running` + fail through the top-level catch. The action prompt has no
    // content ref, so the agent DOES run first.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Do the work." },
          pre_finish: {
            gates: [
              {
                id: "missing-gate",
                kind: "command_check",
                mode: "blocking",
                command: "check {{ artifacts.missing.content }}",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeAgentSupervisor(),
    });

    const gateRows = (await db
      .select()
      .from(schema.gateResults)
      .where(eq(schema.gateResults.runId, seeded.runId))) as Array<{
      status: string;
    }>;

    // The gate was created then marked terminal — NO row left `running`.
    expect(gateRows.length).toBeGreaterThan(0);
    expect(gateRows.every((g) => g.status !== "running")).toBe(true);
    expect(gateRows.some((g) => g.status === "failed")).toBe(true);
    // The blocking gate failed → node + run fail cleanly.
    expect((await getAttempt(seeded.runId, "consume"))?.status).toBe("Failed");
    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 120_000);

  it("a file artifact larger than the inline cap is truncated at injection (bounded read, Codex #2)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "produce",
          type: "cli",
          action: { command: "echo ok" },
          output: { produces: [{ id: "big", kind: "log", path: "big.log" }] },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Body: {{ artifacts.big.content }}" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const dir = await runDirOf(seeded);

    // 400 KiB file, cap at 1 KiB → injected body must be bounded + marked truncated.
    process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES = "1024";
    await writeFile(join(dir, "big.log"), "Z".repeat(400 * 1024), "utf8");

    try {
      await runFlow(seeded.runId, {
        db,
        runtimeRoot: seeded.runtimeRoot,
        supervisorApi: makeAgentSupervisor(),
      });

      const consume = await getAttempt(seeded.runId, "consume");
      const prompt = consume?.resolvedPrompt ?? "";

      // The injected body is bounded near the cap (NOT the full 400 KiB), and the
      // in-band truncation marker is present.
      expect(prompt.length).toBeLessThan(8 * 1024);
      expect(prompt).toContain("artifact body truncated");
    } finally {
      delete process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES;
    }
  }, 120_000);

  it("a gone payload on a referenced id fails the node with CONFIG before the agent spawns", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "Body: {{ artifacts.g.content }}" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    // A file locator pointing at a file that does not exist → gone → CONFIG.
    await seedArtifactRow(seeded.runId, "g", "log", "runner", {
      kind: "file",
      path: "vanished.log",
    });

    const api = makeAgentSupervisor();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const run = await getRun(seeded.runId);
    const consume = await getAttempt(seeded.runId, "consume");

    expect(run.status).toBe("Failed");
    expect(consume?.status).toBe("Failed");
    expect(consume?.errorCode).toBe("CONFIG");
    // No agent session was ever created — the node failed before spawn.
    expect(api.createSession).not.toHaveBeenCalled();
  }, 120_000);
});
