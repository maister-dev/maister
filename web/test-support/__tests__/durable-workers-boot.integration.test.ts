// P0-2 — the three durable workers in the PRODUCTION web boot.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";
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

// The adapter holds its terminal response this long after streaming output.
// The window has to outlast a SIGKILL plus the assertions around it, and stay
// well inside the per-case budget. Sized for the PARALLEL integration lane,
// not for an idle host: this suite runs among ~480 files there, and CPU
// starvation between admission and the poll that notices it is what closes the
// window early. 60 s costs ~40 s per row after the kill and buys that margin.
const TERMINAL_DELAY_MS = 60_000;
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
      const res = await api("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: flowTaskId }),
      });

      if (![200, 201, 202].includes(res.status))
        throw new Error(
          `flow launch answered ${res.status}: ${await res.text()}`,
        );
      const body = (await res.json()) as { id?: string; runId?: string };
      const runId = body.runId ?? body.id;

      if (!runId)
        throw new Error(
          `flow launch returned no run id: ${JSON.stringify(body)}`,
        );

      return runId;
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
        headers: { "content-type": "application/json" },
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
            terminalDelayMs: TERMINAL_DELAY_MS,
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
    supervisor = await startRealSupervisor({
      runtimeRoot: supervisorRoot,
      workspaceRoots: [worktreesRoot, base],
      // The adapter stays alive between turns and advertises resume: the
      // restarted web must be able to re-attach rather than start over.
      fixtureArgs: ["--hang", "--supports-resume"],
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
      terminalDelayMs: TERMINAL_DELAY_MS,
    });

    flowTaskId = flow.taskId;
    const agent = await seedAgentDefinition(testDatabase.db, {
      projectId: project.projectId,
      installedPath: path.join(packagesRoot, "agent"),
      terminalDelayMs: TERMINAL_DELAY_MS,
    });

    agentPath = `/api/projects/${project.slug}/agents/${encodeURIComponent(agent.agentId)}/launch`;
    logs = EVIDENCE_DIR ?? base;
    await mkdir(logs, { recursive: true });
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

        const before = await promptIdsForKind(testDatabase.db, ownerKind);
        // The launch call is NOT awaited: the kill window opens at admission,
        // and the scratch launch's SSE stream can outlive the turn it started.
        // The web is about to be SIGKILLed under it, so its rejection is
        // expected and must not become an unhandled rejection.
        const launched = launch().catch(() => undefined);
        const accepted = await awaitOwnedPrompt(
          testDatabase.db,
          ownerKind,
          before,
        );
        const runId = accepted.runId;

        expect(
          accepted.completionAppliedAt,
          `${domain}: the turn settled before the kill window opened — raise TERMINAL_DELAY_MS`,
        ).toBeNull();
        await web.kill("SIGKILL");
        await launched;
        web = await web.restart();
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
        expect(await countStartedLines()).toBeGreaterThan(startedBeforeLaunch);
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
      }, 600_000);
    },
  );

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

      expect(kinds).toHaveLength(5);
      // Drop exactly one family: the composition must refuse rather than start
      // a worker that owns four of five kinds.
      const { flowPromptOwners } = await import(
        "@/lib/flows/graph/prompt-owner"
      );

      expect(() => composePromptOwnerRegistry([flowPromptOwners])).toThrow(
        expect.objectContaining({ code: "CONFIG" }),
      );
      expect(health.durableWorkersHealth().promptOwner.state).toBe("stopped");
    });

    it("R2: composing the agent registry beside the consensus-draft one is a CONFIG failure by design", async () => {
      const [
        { composePromptOwnerRegistry },
        { flowPromptOwners },
        { consensusDraftPromptOwners },
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
          consensusDraftPromptOwners,
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

    it("R5: a double start returns the same three handles", async () => {
      const { startDurableWorkers, stopDurableWorkers } = await import(
        "@/lib/workers/runtime"
      );
      const first = startDurableWorkers();

      try {
        const second = startDurableWorkers();

        expect(second.promptOwner).toBe(first.promptOwner);
        expect(second.flowContinuation).toBe(first.flowContinuation);
        expect(second.agentContinuation).toBe(first.agentContinuation);
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

      quiesceApplication();
      expect(() => startDurableWorkers()).toThrow(
        expect.objectContaining({ code: "EXECUTOR_UNAVAILABLE" }),
      );
      expect(health.durableWorkersHealth().promptOwner.state).toBe("stopped");
    });
  });
});
