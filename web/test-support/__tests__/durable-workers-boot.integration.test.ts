// P0-2 / R18 — the four durable workers in the PRODUCTION web boot.
//
// The proof lane is `server.ts` over a fresh `next build` against a real
// supervisor and real Postgres; a mocked unit suite cannot show that
// `instrumentation.ts` starts anything. Every case here is written so that it
// fails on a HEAD without `lib/workers/*` for a NAMED reason, not by import
// error — the registry cases reach the composition root through a dynamic
// import inside the test body so the domain rows still produce their own
// evidence.
//
//   A/B/C  one parameterized control per domain (flow, agent, scratch):
//          launch through production HTTP, SIGKILL the web while the prompt is
//          accepted, restart, and assert the durable owner applied the turn.
//   R18    an accepted, repository-deferred launch survives web death and is
//          bound by the restarted task-launch worker without another request.
//   R1-R5  registry composition and worker lifecycle edge cases the happy path
//          cannot reach.
//
// AUTHORSHIP, not timing (trap 9): the boot reconcile sweep runs on every
// start, so "the sweep has not ticked yet" proves nothing. These controls
// attribute the application structurally instead — the SIGKILL destroys the
// in-process waiter that would otherwise apply the command, and nothing
// re-issues a terminal prompt, so the only remaining applier in the restarted
// process is the durable prompt-owner worker. `prompt-owner-worker-started` in
// the restarted process's log is asserted alongside it (trap 2), because a
// registry that fails to compose leaves the worker silently unstarted.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { launchFlowThroughHttp } from "@/test-support/launch-flow-through-http";
import * as schema from "@/lib/db/schema";
import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  type RealSupervisor,
} from "@/test-support/real-supervisor";
import {
  buildProductionWeb,
  signInWithCredentials,
  startRealWeb,
  type RealWeb,
} from "@/test-support/real-web";
import {
  fixturePrompt,
  seedAdmin,
  seedAgentDefinition,
  seedFlowTask,
  seedPlatformRunner,
  seedProjectRepo,
  WORKER_ADMIN,
  type SeededProject,
} from "@/test-support/durable-workers-seed";
import {
  awaitOwnedPrompt,
  poll,
  promptCommandsForRun,
  promptIdsForKind,
  type OwnerKind,
} from "@/test-support/durable-workers-ledger";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { createTerminalBarrier } from "@/test-support/durable-workers-terminal";

const terminalTokens = {
  flow: randomUUID(),
  agent: randomUUID(),
  scratch: randomUUID(),
} as const;
// Trap 3: the dead process's runtime-event stream claim holds for
// RUNTIME_EVENT_CLAIM_LEASE_MS (30 s), so terminal evidence lands only after
// one to three lease cycles. Never assert on a fixed short sleep.
const EVIDENCE_BUDGET_MS = 180_000;
const EVIDENCE_DIR = process.env.MAISTER_TEST_EVIDENCE_DIR;

let testDatabase: StartedPostgresTestDb;
let base = "";
let supervisorRoot = "";
let webRoot = "";
let worktreesRoot = "";
let packagesRoot = "";
let supervisor: RealSupervisor;
let web: RealWeb;
let project: SeededProject;
let cookie = "";
let logs = "";
let adapterLog = "";

async function api(
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${web.url}${pathname}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

async function countStartedLines(): Promise<number> {
  const tail = await web.logTail(4 * 1024 * 1024);

  return tail.split("prompt-owner-worker-started").length - 1;
}

async function runStatus(runId: string): Promise<string> {
  const [row] = await testDatabase.db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row?.status ?? "<missing>";
}

// ---------------------------------------------------------------------------
// Domain table — one row per durable owner family the boot must serve.
// ---------------------------------------------------------------------------

type DomainRow = {
  domain: "flow" | "agent" | "scratch";
  ownerKind: OwnerKind;
  /** Launches through production HTTP and returns the run it created. */
  launch: () => Promise<string>;
  /** The domain-visible settlement the applied turn must produce. */
  expectedTerminal: (runId: string) => Promise<boolean>;
};

let flowTaskId = "";
let agentPath = "";

const domains: DomainRow[] = [
  {
    domain: "flow",
    ownerKind: "flow_node_attempt",
    launch: async () => {
      return launchFlowThroughHttp({
        api,
        origin: web.url,
        taskId: flowTaskId,
      });
    },
    expectedTerminal: async (runId) =>
      ["Review", "Done", "Running"].includes(await runStatus(runId)),
  },
  {
    domain: "agent",
    ownerKind: "agent_turn",
    launch: async () => {
      const res = await api(agentPath, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: web.url },
        body: JSON.stringify({}),
      });

      if (![200, 201, 202].includes(res.status))
        throw new Error(
          `agent launch answered ${res.status}: ${await res.text()}`,
        );
      const body = (await res.json()) as { runId?: string; id?: string };
      const runId = body.runId ?? body.id;

      if (!runId)
        throw new Error(
          `agent launch returned no run id: ${JSON.stringify(body)}`,
        );

      return runId;
    },
    expectedTerminal: async (runId) =>
      ["Done", "Review", "Failed"].includes(await runStatus(runId)),
  },
  {
    domain: "scratch",
    ownerKind: "scratch_message",
    launch: async () => {
      const form = new FormData();

      form.append(
        "payload",
        JSON.stringify({
          projectId: project.projectId,
          baseBranch: "main",
          name: `durable-workers ${randomUUID().slice(0, 8)}`,
          prompt: fixturePrompt({
            terminalBarrier: terminalTokens.scratch,
            text: "\nscratch answered\n",
          }),
          reasoningEffort: "high",
          attachments: [],
        }),
      );
      const res = await api("/api/scratch-runs", {
        method: "POST",
        body: form,
      });

      if (res.status !== 200)
        throw new Error(
          `scratch launch answered ${res.status}: ${await res.text()}`,
        );

      return (await readLaunchResult(res)).runId;
    },
    expectedTerminal: async (runId) => {
      const [row] = await testDatabase.db
        .select({ status: schema.scratchRuns.dialogStatus })
        .from(schema.scratchRuns)
        .where(eq(schema.scratchRuns.runId, runId));

      return row?.status === "WaitingForUser";
    },
  },
];

describe("P0-2 durable workers in the production web boot", () => {
  beforeAll(async () => {
    testDatabase = await startMainAndBrainPostgresTestDb({
      databaseName: "durable_workers_boot",
    });
    // R5 starts the real composition root IN THIS PROCESS, and the root
    // resolves its own pool through `getDb()`. Point that at the same
    // container the production web uses, before anything caches a client.
    process.env.DB_URL = testDatabase.container.getConnectionUri();
    base = await mkdtempReal("durable-workers-boot-");
    supervisorRoot = path.join(base, "supervisor");
    webRoot = path.join(base, "web");
    worktreesRoot = path.join(base, "worktrees");
    packagesRoot = path.join(base, "packages");
    await Promise.all(
      [supervisorRoot, webRoot, worktreesRoot, packagesRoot].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    logs = EVIDENCE_DIR ?? base;
    await mkdir(logs, { recursive: true });
    adapterLog = path.join(logs, "adapter-invocations.ndjson");
    supervisor = await startRealSupervisor({
      runtimeRoot: supervisorRoot,
      workspaceRoots: [worktreesRoot, base],
      // The adapter stays alive between turns and advertises resume: the
      // restarted web must be able to re-attach rather than start over.
      fixtureArgs: [
        "--hang",
        "--supports-resume",
        "--controlled-terminal",
        "--invocation-log",
        adapterLog,
      ],
      ...(EVIDENCE_DIR
        ? { logFile: path.join(EVIDENCE_DIR, "supervisor.log") }
        : {}),
    });
    await seedAdmin(testDatabase.db);
    await seedPlatformRunner(testDatabase.db);
    project = await seedProjectRepo(testDatabase.db, base);
    const flow = await seedFlowTask(testDatabase.db, {
      projectId: project.projectId,
      installedPath: path.join(packagesRoot, "flow"),
      terminalBarrier: terminalTokens.flow,
    });

    flowTaskId = flow.taskId;
    const agent = await seedAgentDefinition(testDatabase.db, {
      projectId: project.projectId,
      installedPath: path.join(packagesRoot, "agent"),
      terminalBarrier: terminalTokens.agent,
    });

    agentPath = `/api/projects/${project.slug}/agents/${encodeURIComponent(agent.agentId)}/launch`;
    const buildId = await buildProductionWeb(path.join(logs, "next-build.log"));

    web = await startRealWeb({
      databaseUrl: testDatabase.container.getConnectionUri(),
      supervisorUrl: supervisor.url,
      runtimeRoot: webRoot,
      worktreesRoot,
      logFile: path.join(logs, "web.log"),
    });
    cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        harness: "durable-workers-boot",
        node: process.versions.node,
        buildId,
        supervisorPid: supervisor.pid,
        webPid: web.pid,
        logs,
      }),
    );
  }, 900_000);

  afterAll(async () => {
    await web?.kill();
    await supervisor?.kill();
    // R5 made this process a real client of the container; its pool must close
    // before the container stops, or teardown reports 57P01 for every
    // connection the server terminates under it.
    const { beginDbShutdown, closeDb } = await import("@/lib/db/client");

    beginDbShutdown();
    await closeDb();
    delete process.env.DB_URL;
    await testDatabase?.stop();
    if (base) await rm(base, { recursive: true, force: true });
  }, 180_000);

  describe.each(domains)(
    "$domain: a turn accepted before a web death is applied by the durable owner",
    ({ domain, ownerKind, launch, expectedTerminal }) => {
      it(`applies the ${ownerKind} owner after the production web restarts`, async () => {
        const startedBeforeLaunch = await countStartedLines();

        expect(
          startedBeforeLaunch,
          "trap 2: a registry that fails to compose leaves the worker silently unstarted, " +
            "so boot must log prompt-owner-worker-started before anything else is asserted",
        ).toBeGreaterThanOrEqual(1);

        const issuer = web;
        const terminal = createTerminalBarrier({
          db: testDatabase.db,
          supervisor,
          issuer,
          adapterLog,
          token: terminalTokens[domain],
          timeoutMs: EVIDENCE_BUDGET_MS,
        });
        let launched: Promise<unknown> | undefined;

        try {
          const before = await promptIdsForKind(testDatabase.db, ownerKind);

          // The launch call is NOT awaited: the kill window opens at admission,
          // and the scratch launch's SSE stream can outlive the turn it started.
          // The web is about to be SIGKILLed under it, so its rejection is
          // expected and must not become an unhandled rejection.
          launched = launch().catch(() => undefined);
          const accepted = await awaitOwnedPrompt(
            testDatabase.db,
            ownerKind,
            before,
          );
          const runId = accepted.runId;

          await terminal.waitForHeld(accepted);

          expect(
            accepted.completionAppliedAt,
            `${domain}: the terminal must remain held until after web death`,
          ).toBeNull();
          await issuer.kill("SIGKILL");
          await launched;
          web = await issuer.restart();
          expect(await countStartedLines()).toBeGreaterThan(
            startedBeforeLaunch,
          );
          await terminal.releaseAfterWebDeath();
          cookie = await signInWithCredentials(web.url, WORKER_ADMIN);

          // Terminal evidence reaches Postgres only once the restarted manager
          // takes over the host stream claim, so this waits on applied STATE.
          const settled = await poll(
            async () => {
              const [row] = (
                await promptCommandsForRun(testDatabase.db, runId)
              ).filter((entry) => entry.id === accepted.id);

              return row?.applicationState === "applied" ? row : null;
            },
            EVIDENCE_BUDGET_MS,
            `${domain}: the durable owner to apply command ${accepted.id}`,
          );

          expect(settled.completionAppliedAt).not.toBeNull();
          expect(settled.terminalEvidenceSha256).not.toBeNull();
          // Authorship: the process that held the live waiter is gone, and the
          // restarted one logged its own worker start.
          expect(await countStartedLines()).toBeGreaterThan(
            startedBeforeLaunch,
          );
          // Exactly one prompt per accepted turn — a second would be a
          // double-spend, not a recovery.
          expect(
            (await promptCommandsForRun(testDatabase.db, runId)).filter(
              (row) => row.ownerKind === ownerKind,
            ),
          ).toHaveLength(1);
          expect(
            await expectedTerminal(runId),
            `${domain}: the applied turn did not settle the domain (run status ${await runStatus(runId)})`,
          ).toBe(true);
        } finally {
          try {
            await terminal.close();
          } finally {
            await issuer.kill("SIGKILL");
            await launched;
            if (web === issuer) {
              web = await issuer.restart();
              cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
            }
          }
        }
      }, 600_000);
    },
  );

  it("R18: a deferred accepted launch survives web death and binds once through the restarted production worker without another request", async () => {
    const target = await seedFlowTask(testDatabase.db, {
      projectId: project.projectId,
      installedPath: path.join(packagesRoot, `queued-${randomUUID()}`),
      terminalDelayMs: 0,
    });
    const previewResponse = await api(
      `/api/runs/launch-options?taskId=${target.taskId}`,
    );

    expect(previewResponse.ok).toBe(true);
    const preview = z
      .object({
        settingsToken: z.string().min(1),
        task: z.object({ id: z.string(), revision: z.number().int() }),
      })
      .parse(await previewResponse.json());
    const issuer = web;
    const beforeStarts =
      (await web.logTail(4 * 1024 * 1024)).split("task-launch-worker-started")
        .length - 1;
    let fence: Awaited<
      ReturnType<typeof acquireRepositoryMutationFence>
    > | null = await acquireRepositoryMutationFence(project.repoPath);

    try {
      const acceptedResponse = await api("/api/task-launch-intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: web.url,
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          taskId: target.taskId,
          expectedTaskRevision: preview.task.revision,
          expectedSettingsToken: preview.settingsToken,
        }),
      });

      expect(
        acceptedResponse.status,
        await acceptedResponse.clone().text(),
      ).toBe(202);
      const accepted = z
        .object({
          intentId: z.string(),
          taskId: z.string(),
          runId: z.string().nullable(),
        })
        .parse(await acceptedResponse.json());

      expect(accepted).toMatchObject({ taskId: target.taskId, runId: null });
      const deferred = await poll(
        async () => {
          const [row] = await testDatabase.db
            .select()
            .from(schema.taskLaunchIntents)
            .where(eq(schema.taskLaunchIntents.id, accepted.intentId));

          return row?.state === "queued" &&
            row.reason === "operation_busy" &&
            row.runId === null
            ? row
            : null;
        },
        EVIDENCE_BUDGET_MS,
        "the accepted launch to persist a real repository-contention deferral",
      );

      expect(
        await testDatabase.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.taskLaunchIntentId, accepted.intentId)),
      ).toEqual([]);
      expect(deferred.preparationIdentity?.runId).toBeTruthy();
      expect(
        await testDatabase.db
          .select()
          .from(schema.executionCommands)
          .where(
            eq(
              schema.executionCommands.runId,
              deferred.preparationIdentity!.runId,
            ),
          ),
      ).toEqual([]);
      await issuer.kill("SIGKILL");
      web = await issuer.restart();
      cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
      await fence.release();
      fence = null;
      const committed = await poll(
        async () => {
          const [row] = await testDatabase.db
            .select()
            .from(schema.taskLaunchIntents)
            .where(eq(schema.taskLaunchIntents.id, accepted.intentId));

          return row?.dispatchCommittedAt && row.runId ? row : null;
        },
        EVIDENCE_BUDGET_MS,
        "the restarted task-launch worker to bind the original accepted intent",
      );
      const starts =
        (await web.logTail(4 * 1024 * 1024)).split("task-launch-worker-started")
          .length - 1;

      expect(beforeStarts).toBeGreaterThanOrEqual(1);
      expect(starts).toBeGreaterThan(beforeStarts);
      expect(committed).toMatchObject({
        id: accepted.intentId,
        state: "run_bound",
        attempts: 0,
      });
      expect(
        await testDatabase.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.taskLaunchIntentId, accepted.intentId)),
      ).toHaveLength(1);
      const commands = await poll(
        async () => {
          const rows = await testDatabase.db
            .select({ kind: schema.executionCommands.kind })
            .from(schema.executionCommands)
            .where(eq(schema.executionCommands.runId, committed.runId!));
          const creates = rows.filter((row) => row.kind === "session.create");
          const prompts = rows.filter((row) => row.kind === "session.prompt");

          return creates.length > 0 && prompts.length > 0
            ? { creates, prompts }
            : null;
        },
        EVIDENCE_BUDGET_MS,
        "one owned create and prompt for the recovered accepted launch",
      );

      const serviceLog = z.object({
        msg: z.literal("[FIX:R18] accepted launch pool serviced"),
        workerId: z.string().startsWith("task-launch-worker:"),
        pool: z.literal("flow"),
        runId: z.string(),
        durableProgress: z.literal(true),
      });
      const workerServiced = (await web.logTail(4 * 1024 * 1024))
        .split("\n")
        .some((line) => {
          try {
            const event = serviceLog.safeParse(JSON.parse(line) as unknown);

            return event.success && event.data.runId === committed.runId;
          } catch {
            return false;
          }
        });

      expect(
        workerServiced,
        "the restarted launch worker—not only a boot sweep—must service this exact Run",
      ).toBe(true);
      expect(commands.creates).toHaveLength(1);
      expect(commands.prompts).toHaveLength(1);
    } finally {
      await fence?.release();
      await issuer.kill("SIGKILL");
      if (web === issuer) {
        web = await issuer.restart();
        cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
      }
    }
  }, 600_000);

  // -------------------------------------------------------------------------
  // Registry composition and worker lifecycle (Task 6).
  // -------------------------------------------------------------------------

  describe("registry composition and worker lifecycle", () => {
    it("R1: a registry missing a schema kind refuses to compose with CONFIG and starts nothing", async () => {
      const [{ composePromptOwnerRegistry }, { PROMPT_OWNER_SHAPES }, health] =
        await Promise.all([
          import("@/lib/workers/runtime"),
          import("@/lib/execution-host/prompt-owner-contract"),
          import("@/lib/workers/health"),
        ]);
      const kinds = [
        ...new Set(PROMPT_OWNER_SHAPES.map((shape) => shape.kind)),
      ];

      expect(kinds).toHaveLength(6);
      // Drop exactly one family: the composition must refuse rather than start
      // a worker that owns only a subset of the six kinds.
      const { flowPromptOwners } =
        await import("@/lib/flows/graph/prompt-owner");

      expect(() => composePromptOwnerRegistry([flowPromptOwners])).toThrow(
        expect.objectContaining({ code: "CONFIG" }),
      );
      expect(health.durableWorkersHealth().promptOwner.state).toBe("stopped");
    });

    it("R2: composing the agent registry beside the consensus-draft one is a CONFIG failure by design", async () => {
      const [
        { composePromptOwnerRegistry },
        { flowPromptOwners },
        { createConsensusDraftPromptOwners },
        { agentPromptOwners },
        { scratchPromptOwners },
        { syncPromptOwners },
        { gateChatPromptOwners },
      ] = await Promise.all([
        import("@/lib/workers/runtime"),
        import("@/lib/flows/graph/prompt-owner"),
        import("@/lib/flows/graph/consensus/draft-prompt-owner"),
        import("@/lib/agents/prompt-owner"),
        import("@/lib/scratch-runs/prompt-owner"),
        import("@/lib/runs/sync-prompt-owner"),
        import("@/lib/services/gate-chat-prompt-owner"),
      ]);

      expect(() =>
        composePromptOwnerRegistry([
          flowPromptOwners,
          createConsensusDraftPromptOwners(),
          agentPromptOwners,
          scratchPromptOwners,
          syncPromptOwners,
          gateChatPromptOwners,
        ]),
      ).toThrow(expect.objectContaining({ code: "CONFIG" }));
    });

    it("R4: stopping with nothing started resolves", async () => {
      const { stopDurableWorkers } = await import("@/lib/workers/runtime");

      await expect(stopDurableWorkers()).resolves.toBeUndefined();
    });

    it("R5: a double start returns the same four handles", async () => {
      const { startDurableWorkers, stopDurableWorkers } =
        await import("@/lib/workers/runtime");
      const first = startDurableWorkers();

      try {
        const second = startDurableWorkers();

        expect(second.promptOwner).toBe(first.promptOwner);
        expect(second.flowContinuation).toBe(first.flowContinuation);
        expect(second.agentContinuation).toBe(first.agentContinuation);
        expect(second.taskLaunch).toBe(first.taskLaunch);
      } finally {
        await stopDurableWorkers();
      }
    });
    // `quiesceApplication()` flips a process-wide symbol slot with no reset, so
    // this case runs LAST and leaves the flag set: every later start in this
    // worker would refuse. Ordering is the isolation.
    it("R3: start refuses while the application is stopping", async () => {
      const [{ startDurableWorkers }, { quiesceApplication }, health] =
        await Promise.all([
          import("@/lib/workers/runtime"),
          import("@/lib/server-lifecycle"),
          import("@/lib/workers/health"),
        ]);
      const [{ applyPromptOwner }, { scratchPromptOwners }] = await Promise.all(
        [
          import("@/lib/execution-host/prompt-owner-application"),
          import("@/lib/scratch-runs/prompt-owner"),
        ],
      );

      quiesceApplication();
      expect(() => startDurableWorkers()).toThrow(
        expect.objectContaining({ code: "EXECUTOR_UNAVAILABLE" }),
      );
      await expect(
        applyPromptOwner({
          db: testDatabase.db,
          owners: scratchPromptOwners,
          commandId: randomUUID(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
      expect(health.durableWorkersHealth().promptOwner.state).toBe("stopped");
    });
  });
});
