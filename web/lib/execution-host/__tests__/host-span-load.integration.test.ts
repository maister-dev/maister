// ADR-167 D5 amendment (2026-09-23), D4 T5.3 — load control, OPT-IN:
//
//   MAISTER_HOST_SPAN_LOAD=1 pnpm --filter maister-web exec vitest run \
//     --project integration lib/execution-host/__tests__/host-span-load.integration.test.ts
//
// Six flow runs of one ai_coding turn each run on a real supervisor while a
// fault proxy holds every `session.command` frame of the shared event stream
// for 120 s — the manager lags the host by two minutes. Node completion must
// not depend on that lag: each turn settles from the host's verified span and
// applies within seconds of its terminal on the host, and once the frames
// arrive the canonical events confirm every one without a conflict. Run on a
// quiet machine (check `pmset -g log` for sleep), never beside another lane.
import type { Db } from "@/lib/execution-host/db";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executionCommands, executionEvents, runs } from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { collectExecutionEventLag } from "@/lib/execution-host/events/lag-read-model";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { runFlow } from "@/lib/flows/runner";
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
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

const RUNS = 6;
const LAG_MS = 120_000;
const P95_BUDGET_MS = 10_000;
const enabled = process.env.MAISTER_HOST_SPAN_LOAD === "1";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};

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
      name: `host-span-load-${index}`,
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: {
            prompt: `fixture-output:{"bytes":0,"text":"turn ${index}"}`,
          },
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ];
}

describe.skipIf(!enabled)(
  "host-span settlement under 120 s of ingest lag (T5.3)",
  () => {
    beforeAll(async () => {
      database = await startMainPostgresTestDb({
        databaseName: "eh_host_span_load",
      });
      db = database.db as unknown as Db;
      supervisor = await startRealSupervisor({ fixtureArgs: ["--hang"] });
      proxy = await startSupervisorFaultProxy(supervisor.url);
      restoreUrl = useRealSupervisorUrl(proxy.url);
      resetRegistrarStateForTests();
      resetResolverForTests();
      worker = startProjectionWorker({ db, projectors: canonicalProjectors });
    }, 180_000);

    afterAll(async () => {
      await stopRuntimeEventConsumers();
      restoreUrl();
      await worker?.stop();
      await proxy?.close();
      await supervisor?.kill();
      await database?.stop();
    });

    it("completes every node within seconds of its host terminal and confirms all six without a conflict", async () => {
      const seeded = await Promise.all(
        Array.from({ length: RUNS }, (_, index) => seedFlow(index)),
      );
      const runIds = seeded.map((run) => run.runId);
      const held = proxy.arm(
        {
          caseId: "T5.3-lag",
          method: "GET",
          path: /^\/runtime-events$/,
          eventType: "session.command",
        },
        "hold-events",
      );
      const lagEnds = Date.now() + LAG_MS;
      const flows = runIds.map((runId) =>
        runFlow(runId, {
          db: database.db,
          runtimeRoot: supervisor.runtimeRoot,
          executionHosts: createExecutionHosts({ db }),
        }),
      );

      await Promise.all(flows);
      const reviewed = await db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(inArray(runs.id, runIds));

      expect(reviewed.map((run) => run.status)).toEqual(
        runIds.map(() => "Review"),
      );
      // Every turn finished while the manager still lagged by the whole window.
      expect(Date.now()).toBeLessThan(lagEnds);

      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, lagEnds - Date.now())),
      );
      held.release();
      const prompts = () =>
        db
          .select()
          .from(executionCommands)
          .where(
            and(
              inArray(executionCommands.runId, runIds),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

      await expect
        .poll(
          async () =>
            (await prompts()).filter((row) => row.terminalEventId !== null)
              .length,
          { timeout: 120_000, interval: 500 },
        )
        .toBe(RUNS);
      const settled = await prompts();
      const terminals = await db
        .select({
          id: executionEvents.id,
          occurredAt: executionEvents.occurredAt,
        })
        .from(executionEvents)
        .where(
          inArray(
            executionEvents.id,
            settled.map((row) => row.terminalEventId!),
          ),
        );
      const occurredAt = new Map(
        terminals.map((row) => [row.id, row.occurredAt]),
      );
      const latencies = settled.map(
        (row) =>
          row.completionAppliedAt!.getTime() -
          occurredAt.get(row.terminalEventId!)!.getTime(),
      );
      const p95 = percentile(latencies, 0.95);

      // Reported for the merge note: the numbers, not only the verdict.
      process.stdout.write(
        `${JSON.stringify({ t53: { runs: RUNS, lagMs: LAG_MS, latenciesMs: latencies, p95Ms: p95 } })}\n`,
      );
      expect(settled.map((row) => row.settledFrom)).toEqual(
        settled.map(() => "host_span"),
      );
      expect(settled.map((row) => row.applicationError)).toEqual(
        settled.map(() => null),
      );
      expect(p95).toBeLessThan(P95_BUDGET_MS);
      // Cross-check only: the admin read model sees at least these six.
      const model = await collectExecutionEventLag({
        db: database.db,
        health: { kind: "unavailable" } as unknown as PlatformStatus,
      });

      expect(
        model.commands.hostSpan.reduce(
          (sum, host) => sum + host.hostSpanSettled1h,
          0,
        ),
      ).toBeGreaterThanOrEqual(RUNS);
    }, 420_000);
  },
);
