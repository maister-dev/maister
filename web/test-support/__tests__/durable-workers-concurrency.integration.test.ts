// P0-2 — four racers on one command, and the shutdown disjunction.
//
// Activation puts a durable applier beside every live waiter, so single-winner
// stops being a property of "only one thing ever tries". These cases run the
// PRODUCTION web (`server.ts` over a fresh `next build`) against a real
// supervisor and real Postgres, and each one names the serializer it is
// exercising rather than asserting a count that a lucky schedule could satisfy.
//
//   D1 live waiter + worker, one command      -> exactly one application
//   D2 two production web instances, one DB   -> exactly one application
//   D3 reconcile reattach + flow worker       -> exactly one driver  (Scope 6)
//   D4 queued-recover promotion + worker      -> exactly one driver  (Scope 6)
//   E  SIGTERM while a claim is HELD          -> released in the drain, or
//                                                shutdown fails loudly and the
//                                                claim expires by its lease
//
// D1, D2 and E turn green with the boot wiring. D3 and D4 are written with the
// crash-recover arm they exercise (Phase 4), RED-first inside that phase — a
// racer against a predicate that does not exist yet can only fail for the
// wrong reason.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, isNotNull, sql } from "drizzle-orm";
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
} from "@/test-support/durable-workers-ledger";
import { mkdtempReal } from "@/test-support/worktree-test-root";

const TERMINAL_DELAY_MS = 60_000;
const EVIDENCE_BUDGET_MS = 180_000;
// Large enough that preparation reads several bounded pages, so the `applying`
// window is observable from outside the process; small enough to stay cheap.
const HELD_CLAIM_BYTES = 2_000_000;
const EVIDENCE_DIR = process.env.MAISTER_TEST_EVIDENCE_DIR;

let testDatabase: StartedPostgresTestDb;
let base = "";
let webRoot = "";
let secondaryRoot = "";
let worktreesRoot = "";
let packagesRoot = "";
let supervisor: RealSupervisor;
let web: RealWeb;
let project: SeededProject;
let cookie = "";
let logs = "";

function apiFor(target: RealWeb) {
  return async (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${target.url}${pathname}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    });
}

/**
 * Starts a scratch turn WITHOUT awaiting its launch stream and resolves as soon
 * as the owned prompt is admitted. Awaiting the stream would hand back a turn
 * that may already have been applied by its live waiter, which turns every
 * "exactly one application" assertion below into a race that never ran — that
 * is how D2 passed against a build with no durable owner at all.
 */
async function launchScratchToAdmission(
  target: RealWeb,
  spec: { terminalDelayMs: number; bytes?: number },
): Promise<{ runId: string; commandId: string; launched: Promise<unknown> }> {
  const before = await promptIdsForKind(testDatabase.db, "scratch_message");
  const form = new FormData();

  form.append(
    "payload",
    JSON.stringify({
      projectId: project.projectId,
      baseBranch: "main",
      name: `race ${randomUUID().slice(0, 8)}`,
      prompt: fixturePrompt({ ...spec, text: "\nraced\n" }),
      reasoningEffort: "high",
      attachments: [],
    }),
  );
  const launched = apiFor(target)("/api/scratch-runs", {
    method: "POST",
    body: form,
  })
    .then(async (res) => {
      if (res.status !== 200)
        throw new Error(
          `scratch launch answered ${res.status}: ${await res.text()}`,
        );

      return readLaunchResult(res);
    })
    // The web under this launch is about to be signalled; a rejected stream is
    // expected and must not surface as an unhandled rejection.
    .catch(() => undefined);
  const accepted = await awaitOwnedPrompt(
    testDatabase.db,
    "scratch_message",
    before,
  );

  return { runId: accepted.runId, commandId: accepted.id, launched };
}

async function appliedPromptCount(runId: string): Promise<number> {
  const rows = await testDatabase.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
        eq(schema.executionCommands.applicationState, "applied"),
        isNotNull(schema.executionCommands.completionAppliedAt),
      ),
    );

  return rows[0]?.count ?? 0;
}

async function promptCount(runId: string): Promise<number> {
  const rows = await testDatabase.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
      ),
    );

  return rows[0]?.count ?? 0;
}

async function startedWorkerCount(target: RealWeb): Promise<number> {
  const tail = await target.logTail(4 * 1024 * 1024);

  return tail.split("prompt-owner-worker-started").length - 1;
}

describe("P0-2 durable worker concurrency and shutdown", () => {
  beforeAll(async () => {
    testDatabase = await startMainAndBrainPostgresTestDb({
      databaseName: "durable_workers_concurrency",
    });
    base = await mkdtempReal("durable-workers-conc-");
    webRoot = path.join(base, "web");
    secondaryRoot = path.join(base, "web-2");
    worktreesRoot = path.join(base, "worktrees");
    packagesRoot = path.join(base, "packages");
    await Promise.all(
      [webRoot, secondaryRoot, worktreesRoot, packagesRoot].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    supervisor = await startRealSupervisor({
      runtimeRoot: path.join(base, "supervisor"),
      workspaceRoots: [worktreesRoot, base],
      fixtureArgs: ["--hang", "--supports-resume"],
      ...(EVIDENCE_DIR
        ? { logFile: path.join(EVIDENCE_DIR, "supervisor-conc.log") }
        : {}),
    });
    await seedAdmin(testDatabase.db);
    await seedPlatformRunner(testDatabase.db);
    project = await seedProjectRepo(testDatabase.db, base);
    logs = EVIDENCE_DIR ?? base;
    await mkdir(logs, { recursive: true });
    await buildProductionWeb(path.join(logs, "next-build-conc.log"));
    web = await startRealWeb({
      databaseUrl: testDatabase.container.getConnectionUri(),
      supervisorUrl: supervisor.url,
      runtimeRoot: webRoot,
      worktreesRoot,
      logFile: path.join(logs, "web-conc.log"),
    });
    cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
  }, 900_000);

  afterAll(async () => {
    await web?.kill();
    await supervisor?.kill();
    await testDatabase?.stop();
    if (base) await rm(base, { recursive: true, force: true });
  }, 180_000);

  it("D1: a live waiter and the durable worker on one command apply it exactly once", async () => {
    // Without a worker there is no race to serialize, so this assertion is the
    // precondition of the whole case rather than decoration.
    expect(
      await startedWorkerCount(web),
      "no durable owner runs in this boot, so the live-waiter/worker race is unreachable",
    ).toBeGreaterThanOrEqual(1);

    const { runId } = await launchScratchToAdmission(web, {
      terminalDelayMs: 2_000,
    });

    await poll(
      async () => ((await appliedPromptCount(runId)) === 1 ? true : null),
      EVIDENCE_BUDGET_MS,
      "the single application of the raced command",
    );
    // Hold past the worker's idle wake so a second applier would have landed.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await appliedPromptCount(runId)).toBe(1);
    expect(await promptCount(runId)).toBe(1);
  }, 420_000);

  it("D2: two production web instances on one database apply a dead instance's command exactly once", async () => {
    const secondary = await startRealWeb({
      databaseUrl: testDatabase.container.getConnectionUri(),
      supervisorUrl: supervisor.url,
      runtimeRoot: secondaryRoot,
      worktreesRoot,
      logFile: path.join(logs, "web-conc-secondary.log"),
    });

    try {
      const { runId, commandId, launched } = await launchScratchToAdmission(
        web,
        { terminalDelayMs: TERMINAL_DELAY_MS },
      );
      const [admitted] = (
        await promptCommandsForRun(testDatabase.db, runId)
      ).filter((row) => row.id === commandId);

      expect(
        admitted?.completionAppliedAt,
        "the turn settled before the kill window opened — raise TERMINAL_DELAY_MS",
      ).toBeNull();
      // The issuing instance dies with its live waiter; the surviving
      // instance's worker is the only applier left, and both would claim if
      // the ledger did not serialize them.
      await web.kill("SIGKILL");
      await launched;
      await poll(
        async () => ((await appliedPromptCount(runId)) === 1 ? true : null),
        EVIDENCE_BUDGET_MS,
        "the surviving instance to apply the dead instance's command exactly once",
      );
      web = await web.restart();
      cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
      await new Promise((r) => setTimeout(r, 5_000));
      expect(await appliedPromptCount(runId)).toBe(1);
      expect(await promptCount(runId)).toBe(1);
    } finally {
      await secondary.kill();
    }
  }, 600_000);

  it("E: SIGTERM while a claim is held either releases it in the drain or fails shutdown loudly", async () => {
    const { runId } = await launchScratchToAdmission(web, {
      terminalDelayMs: 1_000,
      bytes: HELD_CLAIM_BYTES,
    });
    // The disjunction is only meaningful if a claim was observably HELD, so
    // this poll is a precondition: a run that never catches `applying` is
    // under-exercised, not passing.
    const held = await poll(
      async () => {
        const [row] = await testDatabase.db
          .select({
            id: schema.executionCommands.id,
            owner: schema.executionCommands.applicationClaimOwner,
            expires: schema.executionCommands.applicationClaimExpiresAt,
          })
          .from(schema.executionCommands)
          .where(
            and(
              eq(schema.executionCommands.runId, runId),
              eq(schema.executionCommands.kind, "session.prompt"),
              eq(schema.executionCommands.applicationState, "applying"),
              isNotNull(schema.executionCommands.applicationClaimOwner),
            ),
          );

        return row ?? null;
      },
      120_000,
      "an application claim to be observably held",
      10,
    );

    expect(held.owner).not.toBeNull();
    const shutdownStart = Date.now();

    await web.stop();
    const drainMs = Date.now() - shutdownStart;
    const tail = await web.logTail(4 * 1024 * 1024);
    const overran = tail.includes("web workers could not drain");
    const [after] = await testDatabase.db
      .select({
        applicationState: schema.executionCommands.applicationState,
        owner: schema.executionCommands.applicationClaimOwner,
      })
      .from(schema.executionCommands)
      .where(eq(schema.executionCommands.id, held.id));

    // Record which branch fired: trap 5 says the overrun branch is reachable
    // by construction (a renewed 30 s lease outlives a 25 s drain), so a run
    // that never sees it has under-exercised the path rather than passed.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        case: "E",
        branch: overran ? "shutdown-failed-loudly" : "released-in-drain",
        drainMs,
        applicationState: after?.applicationState,
      }),
    );
    if (overran) {
      // The claim is NOT dropped: it stays durable and expires by its lease.
      expect(after?.owner).not.toBeNull();
    } else {
      expect(
        ["pending", "applied"],
        `a drained shutdown must leave no claim mid-flight (state ${after?.applicationState})`,
      ).toContain(after?.applicationState);
    }
    web = await web.restart();
    cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
    await poll(
      async () => ((await appliedPromptCount(runId)) === 1 ? true : null),
      EVIDENCE_BUDGET_MS,
      "exactly one application after the restart",
    );
    expect(await promptCount(runId)).toBe(1);
  }, 600_000);
});
