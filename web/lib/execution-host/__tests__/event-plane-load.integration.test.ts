// ADR-167 amendment (2026-09-25), R20 — event-plane load control, OPT-IN:
//
//   MAISTER_EVENT_PLANE_LOAD=1 pnpm --filter maister-web exec vitest run \
//     --project integration lib/execution-host/__tests__/event-plane-load.integration.test.ts
//
// The concurrency caps' worth of sessions — six flow runs and three agent runs
// — stream from a real supervisor at 10 frames/s each for at least five
// minutes. NO fault proxy sits in the path: it forwards frames eagerly, so a
// manager behind it never fills the host's socket and the host's backpressure
// path would never run. A counting wrapper around the local-direct transport
// counts stream opens, server-ended closes and ACK requests instead. The gate
// requires a flat host-to-manager lag no higher than 2N, no more ACKs than
// committed batches, no server-ended close and no host-span settlement.
//
// Run it alone on a quiet, mains-powered host (`pmset -g log` for sleep,
// `uptime` load < 8), never beside another lane. It prints one JSON line per
// 1 s sample and a final `r20Summary` line; the summary is the number the plan
// records, printed before any assertion so a failing run still reports it.
import type { Db } from "@/lib/execution-host/db";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAgentSession } from "@/lib/agents/launch";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { ensureLocalExecutionDataPlane } from "@/lib/execution-host/event-plane";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { collectExecutionEventLag } from "@/lib/execution-host/events/lag-read-model";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { runFlow } from "@/lib/flows/runner";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  countingLogger,
  countingTransport,
  type TransportCounts,
} from "@/test-support/counting-execution-host-transport";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const enabled = process.env.MAISTER_EVENT_PLANE_LOAD === "1";
const FLOW_RUNS = 6;
const AGENT_RUNS = 3;
const SESSIONS = FLOW_RUNS + AGENT_RUNS;
const FRAMES_PER_SECOND = 10;
const PROFILE_ROWS_PER_SECOND = 360;
const WARMUP_MS = 30_000;
const WINDOW_MS = Number(
  process.env.MAISTER_EVENT_PLANE_LOAD_WINDOW_MS ?? 300_000,
);
// The producer outlives the window so the window never samples a tail-off.
const PRODUCER_SLACK_MS = 30_000;
// The profile is stated in host rows/s. One mock `agent_message_chunk` frame
// commits 1.98 outbox rows (measured 2026-09-25 by this harness's calibration),
// so 10 frames/s per session reaches only ~180 rows/s: 45 ms (~22 frames/s,
// ~396 rows/s across nine sessions) is the smallest round interval above the
// profile. The calibration below re-measures it on every run.
const LINE_INTERVAL_MS = Number(
  process.env.MAISTER_EVENT_PLANE_LOAD_INTERVAL_MS ?? 45,
);
const LINE_BYTES = 256;
const LINES = Math.ceil(
  (WARMUP_MS + WINDOW_MS + PRODUCER_SLACK_MS) / LINE_INTERVAL_MS,
);
const BATCH_ROWS = Number(process.env.MAISTER_EVENT_INGEST_BATCH_ROWS ?? 200);
const SAMPLE_MS = 1_000;
const CATCH_UP_MS = Number(
  process.env.MAISTER_EVENT_PLANE_LOAD_CATCH_UP_MS ?? 900_000,
);

type Sample = {
  t: number;
  head: string | null;
  hostToManager: number | null;
  contiguityGap: number | null;
  ackConfirmation: number | null;
  projectionMaxBacklog: number;
  unacknowledgedCount: number | null;
  subscriberPauses: number | null;
  closes: Record<string, number> | null;
  streamState: string | null;
  streamLastError: unknown;
  rssBytes: number;
  counts: TransportCounts;
  batches: number;
};

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
const oldWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const oldRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const counting = countingTransport(createLocalDirectTransport());
const log = countingLogger("info");

// One committed transaction per logged batch; a per-event tree has no batch
// line and commits every event in its own transaction.
function committedBatches(): number {
  return (
    log.count("runtime-event-batch-ingested") ||
    log.count("runtime-event-ingested")
  );
}

function committedRows(): number {
  return (
    log.sum("runtime-event-batch-ingested", "received") ||
    log.count("runtime-event-ingested")
  );
}

async function seedFlow(index: number) {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: `event-plane-load-${index}`,
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: `stream lines for load run ${index}` },
          transitions: { success: "done" },
        },
      ] as FlowYamlV1["nodes"],
    },
    {
      repoPath,
      flowRevision: true,
      workspace: {
        worktreePath,
        parentRepoPath: repoPath,
        branch: `maister/${name}`,
      },
    },
  );
}

function seedAgent(index: number): Promise<string> {
  return seedAgentRun(db, {
    runtimeRoot: supervisor.runtimeRoot,
    definition: `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nstream lines for load agent ${index}\n`,
    workspace: "none",
    resultContract: null,
  });
}

function toNumber(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

async function sample(t0: number, hostId: string): Promise<Sample> {
  const health = (await counting.transport.platformStatus()) as PlatformStatus;
  const model = await collectExecutionEventLag({ db: database.db, health });
  const stream = model.streams.find((row) => row.executionHostId === hostId);
  const telemetry = stream?.hostTelemetry as
    | (Record<string, unknown> & {
        headSequence: string | null;
        unacknowledgedCount: number;
      })
    | null
    | undefined;

  return {
    t: Date.now() - t0,
    head: telemetry?.headSequence ?? null,
    hostToManager: toNumber(stream?.lag.hostToManager),
    contiguityGap: toNumber(stream?.lag.contiguityGap),
    ackConfirmation: toNumber(stream?.lag.ackConfirmation),
    projectionMaxBacklog: Number(model.consumers.maximumBacklog),
    unacknowledgedCount: telemetry?.unacknowledgedCount ?? null,
    subscriberPauses:
      typeof telemetry?.subscriberPauses === "number"
        ? telemetry.subscriberPauses
        : null,
    closes:
      telemetry?.closes && typeof telemetry.closes === "object"
        ? (telemetry.closes as Record<string, number>)
        : null,
    streamState: stream?.streamState ?? null,
    streamLastError: stream?.lastError ?? null,
    rssBytes: process.memoryUsage().rss,
    counts: { ...counting.counts },
    batches: committedBatches(),
  };
}

function maxOf(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ];
}

describe.skipIf(!enabled)("event-plane throughput under load (R20)", () => {
  beforeAll(async () => {
    database = await startMainPostgresTestDb({
      databaseName: "eh_event_plane_load",
    });
    db = database.db as unknown as Db;
    supervisor = await startRealSupervisor({
      fixtureArgs: [
        "--hang",
        "--lines",
        String(LINES),
        "--line-interval-ms",
        String(LINE_INTERVAL_MS),
        "--line-bytes",
        String(LINE_BYTES),
      ],
      // INFO keeps the host's stream open/close lines (with their reason) in
      // the captured supervisor log.
      env: { LOG_LEVEL: "info" },
    });
    restoreUrl = useRealSupervisorUrl(supervisor.url);
    process.env.MAISTER_WORKTREES_ROOT = path.join(
      supervisor.runtimeRoot,
      "worktrees",
    );
    process.env.MAISTER_RUNTIME_ROOT = path.join(
      supervisor.runtimeRoot,
      "manager",
    );
    resetRegistrarStateForTests();
    resetResolverForTests();
    worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  }, 180_000);

  afterAll(async () => {
    await stopRuntimeEventConsumers();
    await worker?.stop();
    restoreUrl();
    if (oldWorktreesRoot === undefined)
      delete process.env.MAISTER_WORKTREES_ROOT;
    else process.env.MAISTER_WORKTREES_ROOT = oldWorktreesRoot;
    if (oldRuntimeRoot === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = oldRuntimeRoot;
    await supervisor?.kill();
    await database?.stop();
  });

  it(
    "keeps host-to-manager lag flat with no stream close and one ACK per batch",
    async () => {
      // Registering here, with the counting transport, is what starts the ONE
      // consumer loop; every later activation (resolver, launches) finds it.
      const registered = await ensureLocalExecutionDataPlane({
        db,
        transport: counting.transport,
        logger: log.logger,
      });

      expect(registered.status).toBe("registered");
      if (registered.status !== "registered") return;
      const hostId = registered.host.id;
      const flows = await Promise.all(
        Array.from({ length: FLOW_RUNS }, (_, index) => seedFlow(index)),
      );
      const agents = await Promise.all(
        Array.from({ length: AGENT_RUNS }, (_, index) => seedAgent(index)),
      );
      const runIds = [...flows.map((run) => run.runId), ...agents];
      const samples: Sample[] = [];
      const t0 = Date.now();
      const executionHosts = createExecutionHosts({ db });
      const launches = [
        ...flows.map((run) =>
          runFlow(run.runId, {
            db: database.db,
            runtimeRoot: supervisor.runtimeRoot,
            executionHosts,
          }),
        ),
        ...agents.map((runId) => startAgentSession(runId, { db })),
      ].map((launch) =>
        launch.then(
          () => ({ ok: true as const, at: Date.now() - t0 }),
          (error: unknown) => ({
            ok: false as const,
            at: Date.now() - t0,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      const windowEnd = t0 + WARMUP_MS + WINDOW_MS;

      while (Date.now() < windowEnd) {
        const next = Date.now() + SAMPLE_MS;
        const row = await sample(t0, hostId);

        samples.push(row);
        process.stdout.write(`${JSON.stringify({ r20: row })}\n`);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, next - Date.now())),
        );
      }
      // Sampled before teardown: teardown's own shutdown/disconnect closes are
      // not the stream's behaviour under load.
      const atWindowEnd = samples.at(-1)!;
      const outcomes = await Promise.race([
        Promise.all(launches),
        new Promise<null>((resolve) => setTimeout(resolve, CATCH_UP_MS, null)),
      ]);
      const settled = await database.pool.query<{
        settled_from: string | null;
        count: string;
      }>(
        `select settled_from, count(*)::text as count from execution_commands
         where run_id = any($1) and kind = 'session.prompt'
         group by settled_from`,
        [runIds],
      );
      const nodeErrors = await database.pool.query<{ error_code: string }>(
        `select error_code from node_attempts
         where run_id = any($1) and error_code is not null`,
        [runIds],
      );
      const statuses = await database.pool.query<{
        status: string;
        count: string;
      }>(
        `select status, count(*)::text as count from runs
         where id = any($1) group by status`,
        [runIds],
      );
      const finalModel = await collectExecutionEventLag({
        db: database.db,
        health: (await counting.transport.platformStatus()) as PlatformStatus,
      });
      const hostSpanSettled1h = finalModel.commands.hostSpan.reduce(
        (sum, host) => sum + host.hostSpanSettled1h,
        0,
      );
      const post = samples.filter((row) => row.t >= WARMUP_MS);
      const firstMinute = post.filter((row) => row.t < WARMUP_MS + 60_000);
      const lastMinute = post.filter(
        (row) => row.t >= WARMUP_MS + WINDOW_MS - 60_000,
      );
      const lagOf = (rows: Sample[]) =>
        rows.flatMap((row) =>
          row.hostToManager === null ? [] : [row.hostToManager],
        );
      const unackedOf = (rows: Sample[]) =>
        rows.flatMap((row) =>
          row.unacknowledgedCount === null ? [] : [row.unacknowledgedCount],
        );
      const rssOf = (rows: Sample[]) => rows.map((row) => row.rssBytes);
      const headed = post.filter((row) => row.head !== null);
      const firstHead = headed[0];
      const lastHead = headed.at(-1);
      const achievedRowsPerSecond =
        firstHead && lastHead && lastHead.t > firstHead.t
          ? (Number(lastHead.head) - Number(firstHead.head)) /
            ((lastHead.t - firstHead.t) / 1000)
          : 0;
      // Calibration: rows the host committed per frame the sessions sent, over
      // [10 s, 20 s) — every session is streaming by then.
      const calibration = samples.filter(
        (row) => row.t >= 10_000 && row.t < 20_000 && row.head !== null,
      );
      const rowsPerFrame =
        calibration.length > 1
          ? (Number(calibration.at(-1)!.head) - Number(calibration[0]!.head)) /
            (((calibration.at(-1)!.t - calibration[0]!.t) / 1000) *
              SESSIONS *
              (1000 / LINE_INTERVAL_MS))
          : null;
      const perMinute = Array.from(
        { length: Math.ceil(WINDOW_MS / 60_000) },
        (_, minute) => {
          const rows = post.filter(
            (row) =>
              row.t >= WARMUP_MS + minute * 60_000 &&
              row.t < WARMUP_MS + (minute + 1) * 60_000,
          );

          return {
            minute,
            lagMax: maxOf(lagOf(rows)),
            lagP95: percentile(lagOf(rows), 0.95),
            unackedMax: maxOf(unackedOf(rows)),
            rssMaxMiB: Math.round((maxOf(rssOf(rows)) ?? 0) / 1_048_576),
          };
        },
      );
      const summary = {
        batchRows: BATCH_ROWS,
        lineIntervalMs: LINE_INTERVAL_MS,
        lines: LINES,
        sessions: SESSIONS,
        achievedRowsPerSecond: Math.round(achievedRowsPerSecond),
        rowsPerFrame,
        perMinute,
        lagMaxFirstMinute: maxOf(lagOf(firstMinute)),
        lagMaxLastMinute: maxOf(lagOf(lastMinute)),
        lagMax: maxOf(lagOf(post)),
        atWindowEnd: {
          counts: atWindowEnd.counts,
          batches: atWindowEnd.batches,
          subscriberPauses: atWindowEnd.subscriberPauses,
          closes: atWindowEnd.closes,
        },
        final: {
          counts: { ...counting.counts },
          batches: committedBatches(),
          committedRows: committedRows(),
          hostSpanSettled1h,
          settledFrom: settled.rows,
          nodeErrors: nodeErrors.rows.map((row) => row.error_code),
          statuses: statuses.rows,
          launches: outcomes,
          // Before the first ingest there is no stream row to sample.
          streamStates: [...new Set(post.map((row) => row.streamState))],
          streamErrors: post
            .map((row) => row.streamLastError)
            .filter((value) => value !== null)
            .slice(0, 3),
          managerWarnings: log.warnings().slice(-5),
        },
        supervisorLog: supervisor.logFile,
      };

      process.stdout.write(`${JSON.stringify({ r20Summary: summary })}\n`);

      // Validity, not a verdict: a run below the profile proves nothing.
      if (1000 / LINE_INTERVAL_MS < FRAMES_PER_SECOND)
        throw new Error(
          `R20 run invalid: ${1000 / LINE_INTERVAL_MS} frames/s per session is below the ${FRAMES_PER_SECOND} frames/s floor`,
        );
      if (achievedRowsPerSecond < PROFILE_ROWS_PER_SECOND)
        throw new Error(
          `R20 run invalid: achieved ${Math.round(achievedRowsPerSecond)} rows/s < ${PROFILE_ROWS_PER_SECOND}`,
        );
      // The headline gate first: on a per-event tree these are the reds.
      expect(summary.lagMax).not.toBeNull();
      expect(summary.lagMax!).toBeLessThanOrEqual(2 * BATCH_ROWS);
      expect(summary.lagMaxLastMinute!).toBeLessThanOrEqual(
        summary.lagMaxFirstMinute!,
      );
      expect(atWindowEnd.counts.serverEndedCloses).toBe(0);
      expect(atWindowEnd.counts.streamErrors).toBe(0);
      expect(atWindowEnd.counts.ackRequests).toBeLessThanOrEqual(
        atWindowEnd.batches,
      );
      expect(atWindowEnd.closes).toEqual({
        disconnect: 0,
        protocol: 0,
        floor: 0,
        shutdown: 0,
      });
      // The wrapper counts what it claims to: every open stream is either
      // still open or closed for exactly one reason, and every delivered frame
      // was committed once the stream went idle.
      const closed =
        counting.counts.serverEndedCloses +
        counting.counts.streamErrors +
        counting.counts.consumerEndedCloses;

      expect(counting.counts.streamOpens - closed).toBeGreaterThanOrEqual(0);
      expect(counting.counts.streamOpens - closed).toBeLessThanOrEqual(1);
      expect(committedRows()).toBe(counting.counts.eventsDelivered);
      expect(outcomes, "every session finished").not.toBeNull();
      expect(outcomes!.every((outcome) => outcome.ok)).toBe(true);
      expect(hostSpanSettled1h).toBe(0);
      expect(settled.rows).toEqual([
        { settled_from: "canonical", count: String(SESSIONS) },
      ]);
      expect(nodeErrors.rows).toEqual([]);
      expect(summary.final.streamStates).toEqual(["active"]);
      expect(summary.final.streamErrors).toEqual([]);
      expect(maxOf(unackedOf(lastMinute))!).toBeLessThanOrEqual(
        1.25 * maxOf(unackedOf(firstMinute))!,
      );
      expect(maxOf(rssOf(lastMinute))!).toBeLessThanOrEqual(
        1.25 * maxOf(rssOf(firstMinute))!,
      );
    },
    WARMUP_MS + WINDOW_MS + CATCH_UP_MS + 120_000,
  );
});
