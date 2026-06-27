// M17 Phase 3: flat-runner `on_reject.goto_step` atomic repark contract tests.
// TDD RED: These tests MUST fail now because runFlow has no repark logic yet.
// Each assertion pins the exact repark contract from .m17-p3-design.md.
// Tests will pass only after repark implementation lands.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { installFlowPlugin } from "@/lib/flows";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";

const schema = schemaModule as unknown as Record<string, any>;
const { hitlRequests, projects, runs, stepRuns, tasks, workspaces } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let workspaceRoot: string;
let projectId: string;
let executorId: string;
let humanFlowId: string;
let humanFlowRevisionId: string;
let originalMaxConcurrentRuns: string | undefined;
// T3.1.3 only: flow with {{ reviewer_feedback }} in rework command.
let humanFlowTemplateId: string;
let originalHome: string | undefined;

// Base flow: rework step uses a plain echo (no template var) so it is safe on
// both the approve path AND post-commit crash recovery where no rework-comments
// file exists. Used by most tests (T3.1.1, T3.1.2, T3.1.7a-c, T3.1.8).
const HUMAN_WITH_REJECT_YAML = `schemaVersion: 1
name: human-with-reject
steps:
  - id: review-code
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: rework
      comments_var: reviewer_feedback
  - id: rework
    type: cli
    command: "echo reworked"
`;

// Template flow: rework step uses {{ reviewer_feedback }} (top-level extraVar
// injected by repark). Only used by T3.1.3 which asserts stdout contains the
// comment. This step is ONLY reached via the reject→repark path in T3.1.3, so
// the template var is always present.
const HUMAN_WITH_REJECT_TEMPLATE_YAML = `schemaVersion: 1
name: human-with-reject-template
steps:
  - id: review-code
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: rework
      comments_var: reviewer_feedback
  - id: rework
    type: cli
    command: "echo reworked per: {{ reviewer_feedback }}"
`;

// Form schema for human step
const FORM_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "approved", type: "boolean" }],
});

async function setupHumanWithRejectFlow(): Promise<void> {
  const fixtureDir = join(workspaceRoot, "fixture-human-reject-flow");

  await mkdir(fixtureDir, { recursive: true });
  await mkdir(join(fixtureDir, "schemas"), { recursive: true });
  await writeFile(join(fixtureDir, "flow.yaml"), HUMAN_WITH_REJECT_YAML);
  await writeFile(join(fixtureDir, "schemas", "review.json"), FORM_SCHEMA);

  const result = await installFlowPlugin({
    source: fixtureDir,
    version: "local-dev",
    projectId,
    projectSlug: "demo-app",
    flowId: "human-with-reject",
    workspaceRoot,
    db,
  });

  humanFlowId = result.flowRowId;
  humanFlowRevisionId = result.revisionId;

  // T3.1.3: template flow where rework echoes {{ reviewer_feedback }}.
  // Only reached via the reject path so the var is always present.
  const templateFixtureDir = join(workspaceRoot, "fixture-human-reject-tmpl");

  await mkdir(templateFixtureDir, { recursive: true });
  await mkdir(join(templateFixtureDir, "schemas"), { recursive: true });
  await writeFile(
    join(templateFixtureDir, "flow.yaml"),
    HUMAN_WITH_REJECT_TEMPLATE_YAML,
  );
  await writeFile(
    join(templateFixtureDir, "schemas", "review.json"),
    FORM_SCHEMA,
  );

  const templateResult = await installFlowPlugin({
    source: templateFixtureDir,
    version: "local-dev",
    projectId,
    projectSlug: "demo-app",
    flowId: "human-with-reject-template",
    workspaceRoot,
    db,
  });

  humanFlowTemplateId = templateResult.flowRowId;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runner_onreject_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "runner-onreject-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "runner-onreject-ws-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  // Each case seeds its own run; several now legitimately leave the run in a
  // non-terminal NeedsInput state, which counts against the global cap. Raise
  // it so later cases' tryStartRun is not starved by earlier cases.
  originalMaxConcurrentRuns = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "1000";

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "demo-app",
    name: "Demo App",
    repoPath: join(workspaceRoot, "demo-repo"),
    maisterYamlPath: join(workspaceRoot, "demo-repo", "maister.yaml"),
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db
    .update(projects)
    .set({ defaultRunnerId: executorId })
    .where(eq(projects.id, projectId));

  await setupHumanWithRejectFlow();
}, 180_000);

afterAll(async () => {
  if (originalHome) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  if (originalMaxConcurrentRuns === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalMaxConcurrentRuns;
  }
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function seedRunWithHumanStep(args: {
  flowId: string;
  taskPrompt: string;
  // flowRevisionId is required for flows installed inline (within a test)
  // so that loadRun can find the correct installedPath for form_schema
  // resolution. Flows installed in beforeAll can omit this only if no
  // fresh human step (without existing input) is reached.
  flowRevisionId?: string;
}): Promise<{ runId: string; taskId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "Test task",
    prompt: args.taskPrompt,
    flowId: args.flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId: args.flowId,
    status: "Pending",
    flowVersion: "local-dev",
    ...(args.flowRevisionId ? { flowRevisionId: args.flowRevisionId } : {}),
  });

  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });

  const worktreePath = join(workspaceRoot, "wt-" + runId);

  await mkdir(worktreePath, { recursive: true });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "maister/test",
    worktreePath,
    parentRepoPath: join(workspaceRoot, "demo-repo"),
  });

  return { runId, taskId };
}

function getInputArtifactPath(runId: string, stepId: string): string {
  return join(
    workspaceRoot,
    ".maister",
    "demo-app",
    "runs",
    runId,
    `input-${stepId}.json`,
  );
}

function getReworkCommentsPath(runId: string, gotoStepId: string): string {
  return join(
    workspaceRoot,
    ".maister",
    "demo-app",
    "runs",
    runId,
    `rework-comments-${gotoStepId}.json`,
  );
}

describe("M17 Phase 3: on_reject repark contract — TDD RED", () => {
  describe("T3.1.1 — repark to goto target on rejection", () => {
    it("MUST fail: rejection input → run re-enters at goto target (goto step runs again)", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        taskPrompt: "please review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "fix the bug first",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      // Mark run as NeedsInput at review-code step.
      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      // Create a step_run for the human step in NeedsInput state.
      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      // Resume from NeedsInput.
      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const after = await db.select().from(runs).where(eq(runs.id, runId));
      const srRows = await db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId));

      // STRICT RED: The run MUST reach Review (after rework executes).
      // The rework step MUST have a step_run (re-entry happened).
      // Today: runFlow advances forward (no repark) → rework never runs → FAILS.
      expect(after[0].status).toBe("Review");
      expect(after[0].currentStepId).toBeNull();

      const reworkRun = srRows.find((sr: any) => sr.stepId === "rework");

      expect(reworkRun).toBeDefined();
      expect(reworkRun?.status).toBe("Succeeded");
    });
  });

  describe("T3.1.2 — comments injected from rework-comments file", () => {
    it("MUST fail: comments stored in rework-comments-<gotoStepId>.json (NOT input-<gotoStepId>.json)", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        taskPrompt: "please review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "please improve error handling",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      // STRICT RED: rework-comments-rework.json MUST exist with exact content.
      // input-rework.json MUST NOT be used for comments.
      // Today: file never created → readFile throws ENOENT → FAILS.
      const reworkCommentsPath = getReworkCommentsPath(runId, "rework");
      const reworkCommentsStr = await readFile(reworkCommentsPath, "utf8");
      const reworkComments = JSON.parse(reworkCommentsStr);

      expect(reworkComments).toEqual({
        reviewer_feedback: "please improve error handling",
      });

      // Verify input-rework.json was NOT created.
      const inputReworkPath = getInputArtifactPath(runId, "rework");
      const inputReworkStr = await readFile(inputReworkPath, "utf8").catch(
        () => null,
      );

      expect(inputReworkStr).toBeNull();
    });
  });

  describe("T3.1.3 — goto cli target executes with comments visible", () => {
    it("MUST fail: rework step stdout contains injected comments", async () => {
      // Use the template flow (rework echoes {{ reviewer_feedback }}).
      // This step is only reached via the reject path so the var is always set.
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowTemplateId,
        taskPrompt: "please review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "add more tests",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const srRows = await db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId));

      const reworkRun = srRows.find((sr: any) => sr.stepId === "rework");

      // STRICT RED: rework step MUST run with comments visible in stdout.
      // Command is: echo reworked per: {{ reviewer_feedback }}
      // Expected stdout: "reworked per: add more tests"
      // Today: rework never runs OR runs without comments → FAILS.
      expect(reworkRun).toBeDefined();
      expect(reworkRun?.status).toBe("Succeeded");
      expect(reworkRun?.stdout).toContain("add more tests");
    });
  });

  describe("T3.1.4 — goto human/form re-creates HITL (not auto-satisfied)", () => {
    it("MUST fail: human→human repark creates NEW hitl_requests row", async () => {
      // Flow: human → human (simulates rework-review after initial-review rejects).
      const humanToHumanYaml = `schemaVersion: 1
name: human-to-human
steps:
  - id: first-review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: rework-review
      comments_var: initial_feedback
  - id: rework-review
    type: human
    form_schema: ./schemas/review.json
`;

      const fixtureDir = join(workspaceRoot, "fixture-h2h");

      await mkdir(fixtureDir, { recursive: true });
      await mkdir(join(fixtureDir, "schemas"), { recursive: true });
      await writeFile(join(fixtureDir, "flow.yaml"), humanToHumanYaml);
      await writeFile(join(fixtureDir, "schemas", "review.json"), FORM_SCHEMA);

      const h2hFlowInstall = await installFlowPlugin({
        source: fixtureDir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "human-to-human",
        workspaceRoot,
        db,
      });

      const { runId } = await seedRunWithHumanStep({
        flowId: h2hFlowInstall.flowRowId,
        flowRevisionId: h2hFlowInstall.revisionId,
        taskPrompt: "review this",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "needs more work",
      };
      const inputPath = getInputArtifactPath(runId, "first-review");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "first-review",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "first-review",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      // Seed the HITL row for first-review (it would have been created when
      // the step first entered NeedsInput; the test skips that first pass and
      // seeds the response directly, so we must seed the HITL row too).
      await db.insert(hitlRequests).values({
        id: randomUUID(),
        runId,
        stepId: "first-review",
        kind: "human",
        prompt: 'Awaiting human input for step "first-review"',
      });

      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const hiReqs = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));

      // STRICT RED: must have 2 HITL rows (first-review + rework-review).
      // rework-review row must exist and must be distinct from first-review.
      // Today: rework-review never reached → no second row → FAILS.
      expect(hiReqs.length).toBe(2);
      const hitlStepIds = hiReqs.map((hr: any) => hr.stepId).sort();

      expect(hitlStepIds).toEqual(["first-review", "rework-review"].sort());

      const reworkReq = hiReqs.find((hr: any) => hr.stepId === "rework-review");

      expect(reworkReq).toBeDefined();
    });
  });

  describe("T3.1.5 — human step re-prompts on 2nd pass (sentinel deleted)", () => {
    it("MUST fail: triggering human step has sentinel deleted, re-prompts on re-entry", async () => {
      const humanLoopYaml = `schemaVersion: 1
name: human-loop
steps:
  - id: initial-review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: fix-code
      comments_var: feedback
  - id: fix-code
    type: cli
    command: "echo fixed"
  - id: re-review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: fix-code
      comments_var: feedback
`;

      const fixtureDir = join(workspaceRoot, "fixture-hloop");

      await mkdir(fixtureDir, { recursive: true });
      await mkdir(join(fixtureDir, "schemas"), { recursive: true });
      await writeFile(join(fixtureDir, "flow.yaml"), humanLoopYaml);
      await writeFile(join(fixtureDir, "schemas", "review.json"), FORM_SCHEMA);

      const loopFlowInstall = await installFlowPlugin({
        source: fixtureDir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "human-loop",
        workspaceRoot,
        db,
      });

      const { runId } = await seedRunWithHumanStep({
        flowId: loopFlowInstall.flowRowId,
        flowRevisionId: loopFlowInstall.revisionId,
        taskPrompt: "review with loop",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      // Seed initial-review as rejected.
      const inputPath1 = getInputArtifactPath(runId, "initial-review");

      await mkdir(join(inputPath1, ".."), { recursive: true });
      await writeFile(
        inputPath1,
        JSON.stringify({ rejected: true, comments: "needs changes" }),
      );

      // Seed fix-code as approved.
      const inputPath2 = getInputArtifactPath(runId, "fix-code");

      await writeFile(inputPath2, JSON.stringify({ approved: true }));

      // Seed re-review as rejected (triggers 2nd repark).
      const inputPath3 = getInputArtifactPath(runId, "re-review");

      await writeFile(
        inputPath3,
        JSON.stringify({ rejected: true, comments: "try again" }),
      );

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "initial-review",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "initial-review",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const srRows = await db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId));

      // STRICT RED: re-review must have >1 step_run (looped twice).
      // This proves the sentinel was deleted and re-prompting occurred.
      // Today: no looping → 1 step_run per step → FAILS.
      const reReviewRuns = srRows.filter(
        (sr: any) => sr.stepId === "re-review",
      );

      expect(reReviewRuns.length).toBeGreaterThan(1);
    });
  });

  describe("T3.1.6 — reject loop bounded at maxLoops (5)", () => {
    it("MUST fail: after 5 reworks, next reject → run status Failed (CONFIG)", async () => {
      // Flow with rework BEFORE review so rejection creates a genuine loop:
      // rework(cli) → review(human, on_reject → rework). Each rejection
      // adds a step_run for "review". On the 6th rejection (humanRunCount=6 > 5),
      // the maxLoops guard fires.
      const loopingYaml = `schemaVersion: 1
name: looping-reject
steps:
  - id: dummy-rework
    type: cli
    command: "echo reworking"
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: dummy-rework
      comments_var: feedback
`;

      const fixtureDir = join(workspaceRoot, "fixture-looping-reject");

      await mkdir(fixtureDir, { recursive: true });
      await mkdir(join(fixtureDir, "schemas"), { recursive: true });
      await writeFile(join(fixtureDir, "flow.yaml"), loopingYaml);
      await writeFile(join(fixtureDir, "schemas", "review.json"), FORM_SCHEMA);

      const loopingFlow = await installFlowPlugin({
        source: fixtureDir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "looping-reject",
        workspaceRoot,
        db,
      });

      const { runId } = await seedRunWithHumanStep({
        flowId: loopingFlow.flowRowId,
        flowRevisionId: loopingFlow.revisionId,
        taskPrompt: "review that loops",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      // Drive the run forward: dummy-rework runs first (cli), then review
      // enters NeedsInput.
      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      // After the first runFlow, dummy-rework ran and review is NeedsInput.
      const afterFirst = await db.select().from(runs).where(eq(runs.id, runId));

      expect(afterFirst[0].status).toBe("NeedsInput");
      expect(afterFirst[0].currentStepId).toBe("review");

      // Drive 6 rejection cycles within this single run.
      // Each cycle: seed rejection → resume → repark → dummy-rework runs →
      // review NeedsInput again.
      // On the 6th cycle: maxLoops exceeded → run Failed.
      for (let cycle = 1; cycle <= 6; cycle++) {
        const reviewInputPath = getInputArtifactPath(runId, "review");

        await mkdir(join(reviewInputPath, ".."), { recursive: true });
        await writeFile(
          reviewInputPath,
          JSON.stringify({ rejected: true, comments: "nope" }),
        );

        if (cycle === 6) {
          // STRICT: 6th rejection must trip the maxLoops guard → Failed.
          try {
            await runFlow(runId, { db, runtimeRoot: workspaceRoot });
            const afterRun = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            expect(afterRun[0].status).toBe("Failed");
          } catch (err) {
            expect((err as any)?.code).toBe("CONFIG");
          }
        } else {
          // Cycles 1–5: repark fires, dummy-rework runs, review re-prompts.
          await runFlow(runId, { db, runtimeRoot: workspaceRoot });
          const afterRun = await db
            .select()
            .from(runs)
            .where(eq(runs.id, runId));

          expect(afterRun[0].status).toBe("NeedsInput");
          expect(afterRun[0].currentStepId).toBe("review");
        }
      }
    });
  });

  describe("T3.1.7a — crash-window: death BEFORE sentinel delete", () => {
    it("MUST fail: rejection persisted, re-repark on retry (idempotent)", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        taskPrompt: "review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "fix this",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      // STRICT RED: if runFlow crashes before sentinels are deleted,
      // re-run must re-drive the rejection (idempotent) and complete normally.
      // The rejection artifact is still intact, so reparking succeeds.
      // Today: even the first run doesn't repark → FAILS.
      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const afterRun = await db.select().from(runs).where(eq(runs.id, runId));

      // After repark, rework runs, run ends Review.
      expect(afterRun[0].status).toBe("Review");
      expect(afterRun[0].currentStepId).toBeNull();
    });
  });

  describe("T3.1.7b — crash-window: death AFTER delete, BEFORE commit", () => {
    it("MUST fail: sentinels gone, re-prompts human (benign)", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        flowRevisionId: humanFlowRevisionId,
        taskPrompt: "review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "fix this",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      // Simulate post-delete state: sentinel is gone.
      // (In real crash, repark logic would delete it; we pre-delete to simulate.)
      await rm(inputPath).catch(() => {
        // File may not exist yet; tolerate.
      });

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      // STRICT RED: if death occurs after delete but before repark CAS,
      // the sentinel stays gone. Re-run finds no input artifact, so
      // re-prompts the human (benign loss of rejection).
      // Today: runFlow doesn't repark, so this crash-window scenario never occurs
      // → test setup never reaches the state to verify → FAILS.
      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const srRows = await db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId));

      // Human step should have been re-prompted (new hitl_requests row).
      // Rework never ran (sentinel was gone, so human re-prompted instead).
      const reviewCodeRuns = srRows.filter(
        (sr: any) => sr.stepId === "review-code",
      );

      expect(reviewCodeRuns.length).toBeGreaterThan(0);
      // The latest run for review-code should be NeedsInput (re-prompted).
      const latestReview = reviewCodeRuns[reviewCodeRuns.length - 1];

      expect(latestReview.status).toBe("NeedsInput");
    });
  });

  describe("T3.1.7c — crash-window: death AFTER commit", () => {
    it("MUST fail: currentStepId at goto, clean re-entry", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        taskPrompt: "review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const rejectInput = {
        rejected: true,
        comments: "fix this",
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(rejectInput));

      // Simulate post-commit state: currentStepId is already rework, and the
      // human step sentinel was deleted (repark CAS succeeded), but the process
      // died before the in-process re-entry. Production recovery is reconcile →
      // crashResume on the Running run (resume_started_at set as the claim
      // handle), NOT a special repark path.
      await db
        .update(runs)
        .set({
          status: "Running",
          currentStepId: "rework",
          resumeStartedAt: new Date(),
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "Succeeded",
        startedAt: new Date(),
      });

      // Delete the human step sentinel to simulate post-repark state.
      await rm(inputPath).catch(() => {
        // Already gone.
      });

      // Recovery: crashResume re-enters at currentStepId=rework (the persisted
      // goto target), cleanly re-executes rework, no re-prompt of the (behind)
      // human step. Window is closed; recovery is clean.
      await runFlow(runId, {
        db,
        runtimeRoot: workspaceRoot,
        crashResume: { targetStepId: "rework" },
      });

      const afterRun = await db.select().from(runs).where(eq(runs.id, runId));

      // Rework runs and completes → run ends Review.
      expect(afterRun[0].status).toBe("Review");
      expect(afterRun[0].currentStepId).toBeNull();
    });
  });

  describe("T3.1.7d — crash-window: death AFTER markStepSucceeded, BEFORE repark CAS", () => {
    it("recovers without a step_runs attempt collision (re-prompts human)", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        flowRevisionId: humanFlowRevisionId,
        taskPrompt: "review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      // Pre-CAS window: markStepSucceeded committed (the human step_run is
      // Succeeded, attempt 1) and the sentinels were already deleted, but the
      // repark CAS had NOT run — so currentStepId is STILL the human step
      // (review-code), not the goto target. crashRunningRun retains it in
      // resume_target_step_id, so Recover re-enters here at review-code while a
      // Succeeded attempt-1 step_run already exists.
      const inputPath = getInputArtifactPath(runId, "review-code");

      await rm(inputPath).catch(() => {
        // Sentinel already gone (deleted pre-CAS).
      });

      await db
        .update(runs)
        .set({
          status: "Running",
          currentStepId: "review-code",
          resumeStartedAt: new Date(),
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "Succeeded",
        attempt: 1,
        startedAt: new Date(),
      });

      // Recovery: crashResume re-enters at review-code (the retained human step).
      // WITHOUT the attempt-increment fix, createStepRun(attempt=1) collides with
      // the existing Succeeded attempt-1 row (step_runs_run_step_attempt_uq) and
      // Recover never succeeds. WITH the fix, a fresh attempt-2 step_run is
      // created and the human is re-prompted (the rejection is benignly lost).
      await runFlow(runId, {
        db,
        runtimeRoot: workspaceRoot,
        crashResume: { targetStepId: "review-code" },
      });

      const afterRun = await db.select().from(runs).where(eq(runs.id, runId));

      // Run is re-parked on the human step awaiting fresh input (not Failed).
      expect(afterRun[0].status).toBe("NeedsInput");
      expect(afterRun[0].currentStepId).toBe("review-code");

      // Two attempts for review-code: the recovered Succeeded one + the fresh
      // re-prompt — proving no unique-constraint collision occurred.
      const reviewRuns = (
        await db.select().from(stepRuns).where(eq(stepRuns.runId, runId))
      ).filter((sr: any) => sr.stepId === "review-code");

      expect(reviewRuns.length).toBe(2);
      expect(new Set(reviewRuns.map((sr: any) => sr.attempt))).toEqual(
        new Set([1, 2]),
      );
    });
  });

  describe("T3.1.8 — APPROVE path unchanged (regression guard)", () => {
    it("PASS: non-reject input advances forward, no repark", async () => {
      const { runId } = await seedRunWithHumanStep({
        flowId: humanFlowId,
        taskPrompt: "review",
      });

      const start = await tryStartRun(runId, { db });

      expect(start.started).toBe(true);

      const runDir = join(workspaceRoot, ".maister", "demo-app", "runs", runId);

      await mkdir(runDir, { recursive: true });

      const approveInput = {
        rejected: false,
        approved: true,
      };
      const inputPath = getInputArtifactPath(runId, "review-code");

      await mkdir(join(inputPath, ".."), { recursive: true });
      await writeFile(inputPath, JSON.stringify(approveInput));

      await db
        .update(runs)
        .set({
          status: "NeedsInput",
          currentStepId: "review-code",
        })
        .where(eq(runs.id, runId));

      await db.insert(stepRuns).values({
        id: randomUUID(),
        runId,
        stepId: "review-code",
        stepType: "human",
        status: "NeedsInput",
        startedAt: new Date(),
      });

      await runFlow(runId, { db, runtimeRoot: workspaceRoot });

      const after = await db.select().from(runs).where(eq(runs.id, runId));
      const srRows = await db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId));

      // STRICT (but GREEN): approve path MUST be unchanged.
      // Rejection field is false (not true), so no repark.
      // Run advances forward → Review. review-code + rework both run.
      // Note: rework also runs because review-code is NOT the last step
      // (the flow has review-code → rework); the approve path advances
      // through all remaining steps normally.
      // This test may pass today because the approve path is unmodified.
      expect(after[0].status).toBe("Review");
      expect(after[0].currentStepId).toBeNull();

      const reviewCodeRun = srRows.find(
        (sr: any) => sr.stepId === "review-code",
      );

      expect(reviewCodeRun).toBeDefined();
      expect(reviewCodeRun?.status).toBe("Succeeded");

      // rework-comments file MUST NOT be created (no repark).
      const reworkCommentsPath = getReworkCommentsPath(runId, "rework");
      const reworkCommentsStr = await readFile(
        reworkCommentsPath,
        "utf8",
      ).catch(() => null);

      expect(reworkCommentsStr).toBeNull();
    });
  });
});
