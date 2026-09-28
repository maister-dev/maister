// ADR-183 T4.5 — RED D3-scratch: a scratch dialog whose turn the execution
// host parks under outbox pressure is left retryable (`WaitingForUser`) with
// the cause recorded, so the conversation can say the HOST paused it rather
// than show a bare failure. Against a real supervisor (the resumable mock
// adapter floods and holds its first turn) behind the fault proxy, which
// holds every runtime-event frame — the manager is behind.
//
// The send-time `session/resume` of the checkpointed session is A4's residual
// (owner decision Q2); this suite pins only the classification.
import type { Db } from "@/lib/execution-host/db";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

const execFileAsync = promisify(execFile);
const USER_ID = "scratch-host-pressure-user";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: USER_ID,
    email: "scratch@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

type Service = typeof import("@/lib/scratch-runs/service");

let service: Service;
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let supervisor: RealSupervisor;
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let projectId: string;
const savedEnv: Record<string, string | undefined> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);

  return stdout;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "adr183_scratch_host_pressure",
  });
  db = testDatabase.db;
  const journalDir = await mkdtemp(join(tmpdir(), "adr183-scratch-journal-"));

  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "2000",
      MAISTER_KILL_GRACE_MS: "3000",
      MAISTER_EVENT_OUTBOX_LOW_ROWS: "4",
      MAISTER_EVENT_OUTBOX_SOFT_ROWS: "24",
      MAISTER_EVENT_OUTBOX_HARD_ROWS: "4000",
      MOCK_ACP_STATE_DIR: journalDir,
      MOCK_ACP_FLOOD_FRAMES: "30",
      MOCK_ACP_FLOOD_BYTES: "1024",
      MOCK_ACP_HOLD_AFTER_FLOOD: "1",
    },
  });
  proxy = await startSupervisorFaultProxy(supervisor.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: db as unknown as Db,
    projectors: canonicalProjectors,
  });
  service = await import("@/lib/scratch-runs/service");
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
  ])
    savedEnv[key] = process.env[key];
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  process.env.MAISTER_RUNTIME_ROOT = join(supervisor.runtimeRoot, "runtime");
  process.env.MAISTER_WORKTREES_ROOT = join(
    supervisor.runtimeRoot,
    "worktrees",
  );

  const repo = await mkdtemp(join(supervisor.runtimeRoot, "repo-"));
  const runnerId = randomUUID();

  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");

  projectId = randomUUID();
  await db.insert(schema.users).values({
    id: USER_ID,
    email: `${USER_ID}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof schema.platformAcpRunners.$inferInsert,
    );
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `scratch-${projectId.slice(0, 8)}`,
    name: "Scratch host pressure",
    repoPath: repo,
    taskKey: "SHP",
  });
}, 240_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await stopRuntimeEventConsumers();
  restoreUrl();
  await proxy?.close();
  await worker?.stop();
  await supervisor?.kill();
  await testDatabase?.stop();
});

async function hostPressured(): Promise<boolean> {
  const health = (await (
    await fetch(`${supervisor.url}/health?includeStream=true`)
  ).json()) as { stream?: { pressured: boolean } };

  return health.stream?.pressured === true;
}

describe("ADR-183 D3-scratch — a host-parked dialog is classified", () => {
  it("leaves the dialog WaitingForUser with cause host_pressure, and the notice key resolves in both locales", async () => {
    const body: ScratchLaunchInput = {
      projectId,
      baseBranch: "main",
      prompt: "Remember ALBATROSS-42",
      reasoningEffort: "high",
      attachments: [],
    };
    const held = proxy.arm(
      {
        caseId: "adr183-scratch-behind",
        method: "GET",
        path: /^\/runtime-events$/,
      },
      "hold-events",
    );
    let launch: Promise<unknown> = Promise.resolve();

    try {
      const staged = service.launchScratchRunStaged({
        body,
        userId: USER_ID,
      });

      launch = (async () => {
        for (;;) {
          const step = await staged.next();

          if (step.done) return step.value;
        }
      })().catch(() => undefined);
      await expect
        .poll(hostPressured, { timeout: 30_000, interval: 100 })
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await supervisor.logTail(4_000_000)).includes(
              "checkpoint complete",
            ),
          { timeout: 30_000, interval: 100 },
        )
        .toBe(true);
    } finally {
      held.release();
    }
    await launch;

    const [run] = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, projectId),
          eq(schema.runs.runKind, "scratch"),
        ),
      );
    const readDialog = async () =>
      (
        await db
          .select()
          .from(schema.scratchRuns)
          .where(eq(schema.scratchRuns.runId, run.id))
      )[0];

    await expect
      .poll(async () => (await readDialog())?.dialogStatus, {
        timeout: 60_000,
        interval: 100,
      })
      .toBe("WaitingForUser");
    const dialog = await readDialog();

    expect(dialog.errorMetadata).toEqual({ cause: "host_pressure" });
    expect(dialog.errorCode).not.toBeNull();
    expect(en.scratch.hostPaused).toBeTruthy();
    expect(ru.scratch.hostPaused).toBeTruthy();
  }, 180_000);
});
