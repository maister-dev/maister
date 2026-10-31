import type { Db } from "@/lib/execution-host/db";
import type {
  OperationalCleanup,
  OperationalTerminal,
} from "@/lib/run-results/operational-types";
import type {
  AgentIncidentFact,
  IncidentRun,
} from "@/lib/runs/agent-incidents";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAgentComparisonScopes } from "@/lib/agents/activity-snapshot";
import { publishRunResult } from "@/lib/run-results/ledger";
import {
  operationalContractFixture,
  operationalSuccessFixture,
} from "@/test-support/operational-agent";
import {
  projects,
  runs,
  agentIncidentEpisodes,
  agentIncidentOccurrences,
} from "@/lib/db/schema";
import {
  classifyAgentTerminalFailure,
  applyAgentCleanupIncident,
  applyAgentTerminalIncidents,
  recordAgentIncident,
} from "@/lib/runs/agent-incidents";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
const failureTime = new Date("2026-10-01T01:00:00Z");
const successTime = new Date("2026-10-01T02:00:00Z");
const terminal: OperationalTerminal = {
  version: 1,
  status: "Done",
  cause: "completed",
  effectiveOutcome: "success",
  successful: true,
  validation: "valid",
  integrity: "clean",
  baselineGeneration: 1,
  resultRevision: 1,
  reasonCodes: [],
  evidenceIds: [],
};

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "agent_incidents" });
  db = database.db as unknown as Db;
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

async function fixture(): Promise<IncidentRun> {
  const projectId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: projectId,
    name: "Incidents",
    taskKey: `T${projectId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath: `/unused/${projectId}`,
    maisterYamlPath: "/unused/maister.yaml",
  });
  const [run] = await db
    .insert(runs)
    .values({
      id: randomUUID(),
      projectId,
      runKind: "agent",
      agentKind: "operational",
      resultContract: operationalContractFixture("none"),
      agentWorkspace: "none",
      flowVersion: "agent",
      flowRevision: "manual",
      status: "Running",
      sourceAgentId: "core:fixture",
      launchedAt: failureTime,
      activitySortAt: failureTime,
      activityTimestampProvenance: "launch",
      agentActivitySnapshot: {
        version: 1,
        agentId: "core:fixture",
        displayName: "Fixture",
        definitionSha256: "a".repeat(64),
        packageInstallId: "fixture-install",
        packageName: "core",
        packageVersion: "v1",
        packageRevision: null,
        comparisonScopes: { business: "business", infrastructure: "runner-a" },
      },
    })
    .returning();

  return run;
}
function fact(run: IncidentRun, key: string): AgentIncidentFact {
  return {
    projectId: run.projectId!,
    agentId: run.sourceAgentId!,
    sourceFactKey: key,
    scopeKey: "runner-a",
    scopeKind: "infrastructure",
    fingerprint: "session-create-auth",
    reasonCode: "authorization",
    runId: run.id,
    channel: "execution_failure",
    observedAt: failureTime,
  };
}
async function success(
  run: IncidentRun,
  launchedAt: Date,
  scope: string = "runner-a",
): Promise<void> {
  await db.transaction(async (tx) => {
    const contract = operationalContractFixture("none");
    const [witness] = await tx
      .insert(runs)
      .values({
        id: randomUUID(),
        projectId: run.projectId,
        runKind: "agent",
        agentKind: "operational",
        resultContract: operationalContractFixture("none"),
        flowVersion: "agent",
        flowRevision: "manual",
        status: "Done",
        agentWorkspace: "none",
        sourceAgentId: run.sourceAgentId,
        launchedAt,
        activitySortAt: launchedAt,
        activityTimestampProvenance: "launch",
        endedAt: successTime,
        agentActivitySnapshot: {
          ...run.agentActivitySnapshot!,
          comparisonScopes: { business: "business", infrastructure: scope },
        },
        operationalTerminal: terminal,
      })
      .returning();
    const value = operationalSuccessFixture();

    await publishRunResult(tx, {
      runId: witness.id,
      contract,
      value,
      valueBytes: Buffer.byteLength(JSON.stringify(value)),
      producerKind: "agent_session",
      producerRef: "session:default",
    });
    await applyAgentTerminalIncidents(tx, {
      run: witness,
      status: "Done",
      endedAt: successTime,
      transitionId: randomUUID(),
      reason: undefined,
      terminal,
      reported: null,
    });
  });
}
function cleanup(
  state: OperationalCleanup["state"],
  revision: number,
): OperationalCleanup {
  return {
    version: 1,
    resourceKind: "plain_directory",
    workspace: "none",
    state,
    revision,
    armedAt: failureTime.toISOString(),
    attempts: 3,
    dueAt: null,
    errorCode: "resource_busy",
    evidenceIds: [],
    removedAt: null,
    releasedAt: null,
    lease: null,
    rearmReceipt: null,
  };
}

describe("Agent incident lifecycle", () => {
  it("IT-UX-02 normalizes scan scopes, retains event inputs and prioritizes platform evidence", async () => {
    const run = await fixture();
    const configuration = { repository: "owner/repo" };
    const base = {
      configuration,
      taskId: null,
      runner: {
        id: "a",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "model",
        providerKind: "openai",
        permissionPolicy: "ask",
      },
      workspace: "none" as const,
      hostId: "local",
    };
    const manual = withAgentComparisonScopes(run.agentActivitySnapshot!, {
      ...base,
      trigger: { source: "manual" },
    });
    const cron = withAgentComparisonScopes(run.agentActivitySnapshot!, {
      ...base,
      trigger: { source: "cron" },
    });

    expect(manual.comparisonScopes).toEqual(cron.comparisonScopes);
    const one = withAgentComparisonScopes(manual, {
      ...base,
      taskId: "task-a",
      trigger: { source: "domain_event", eventId: 1, payload: { issue: 1 } },
    });
    const replay = withAgentComparisonScopes(manual, {
      ...base,
      taskId: "task-a",
      trigger: { source: "domain_event", eventId: 2, payload: { issue: 1 } },
    });
    const other = withAgentComparisonScopes(manual, {
      ...base,
      taskId: "task-b",
      trigger: { source: "domain_event", eventId: 3, payload: { issue: 2 } },
    });

    expect(one.comparisonScopes).toEqual(replay.comparisonScopes);
    expect(one.comparisonScopes?.business).not.toBe(
      other.comparisonScopes?.business,
    );
    expect(one.comparisonScopes?.infrastructure).toBe(
      other.comparisonScopes?.infrastructure,
    );
    const input = {
      run,
      status: "Failed" as const,
      endedAt: failureTime,
      transitionId: "fixed",
      reason: "a changing diagnostic sentence",
      terminal: {
        ...terminal,
        status: "Failed" as const,
        successful: false,
        validation: "invalid" as const,
        reasonCodes: ["result_invalid"],
      },
      reported: {
        ...operationalSuccessFixture(),
        outcome: "blocked" as const,
        diagnostics: [
          {
            code: "auth",
            operation: "scan",
            severity: "error" as const,
            service: "github",
            httpStatus: 403,
            message: "variable",
            remediation: "Restore permission",
            retryable: false,
          },
        ],
      },
    };
    const classified = classifyAgentTerminalFailure(input);

    expect(classified[0].reasonCode).toBe("result_invalid");
    expect(
      classifyAgentTerminalFailure({
        ...input,
        reason: "different changing prose",
      })[0].fingerprint,
    ).toBe(classified[0].fingerprint);
  });

  it("IT-UX-02 serializes concurrent source facts, keeps repeats quiet and deduplicates replays", async () => {
    const run = await fixture();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        db.transaction((tx) =>
          recordAgentIncident(tx, fact(run, `failure:${run.id}:${index}`)),
        ),
      ),
    );
    await db.transaction(async (tx) => {
      for (let index = 12; index < 1000; index++)
        await recordAgentIncident(tx, fact(run, `failure:${run.id}:${index}`));
      await recordAgentIncident(tx, fact(run, `failure:${run.id}:0`));
    });
    const episodes = await db
      .select()
      .from(agentIncidentEpisodes)
      .where(eq(agentIncidentEpisodes.projectId, run.projectId!));

    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      attentionRevision: 1,
      contentRevision: 1000,
      state: "open",
    });
    expect(
      await db
        .select()
        .from(agentIncidentOccurrences)
        .where(eq(agentIncidentOccurrences.episodeId, episodes[0].id)),
    ).toHaveLength(1000);
  });

  it("IT-UX-03 requires strictly later same-scope recovery and keeps late failures historical", async () => {
    const run = await fixture();
    const first = await db.transaction((tx) =>
      recordAgentIncident(tx, fact(run, `first:${run.id}`)),
    );

    await success(run, failureTime);
    await success(run, new Date("2026-10-01T01:10:00Z"), "runner-b");
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, first))
      )[0].state,
    ).toBe("open");
    await success(run, new Date("2026-10-01T01:20:00Z"));
    const delayed = await db.transaction((tx) =>
      recordAgentIncident(tx, fact(run, `delayed:${run.id}`)),
    );

    expect(delayed).toBe(first);
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, first))
      )[0].state,
    ).toBe("resolved");
    const next = await db.transaction((tx) =>
      recordAgentIncident(tx, {
        ...fact(run, `recurred:${run.id}`),
        observedAt: new Date("2026-10-01T03:00:00Z"),
      }),
    );

    expect(next).not.toBe(first);
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, next))
      )[0].state,
    ).toBe("open");
    const safety = await db.transaction((tx) =>
      recordAgentIncident(tx, {
        ...fact(run, `safety:${run.id}`),
        reasonCode: "source_integrity",
        fingerprint: "source_integrity",
      }),
    );

    await success(run, new Date("2026-10-01T04:00:00Z"));
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, safety))
      )[0].state,
    ).toBe("open");
  });

  it("IT-UX-04 resolves a shared cleanup episode only after every resource owner releases", async () => {
    const run = await fixture();
    const [other] = await db
      .insert(runs)
      .values({
        id: randomUUID(),
        projectId: run.projectId,
        runKind: "agent",
        flowVersion: "agent",
        flowRevision: "manual",
        agentKind: "operational",
        agentWorkspace: "none",
        resultContract: operationalContractFixture("none"),
      })
      .returning();
    const second: IncidentRun = {
      ...other,
      sourceAgentId: run.sourceAgentId,
      agentActivitySnapshot: run.agentActivitySnapshot,
    };

    await db.transaction(async (tx) => {
      await applyAgentCleanupIncident(
        tx,
        run,
        cleanup("exhausted", 1),
        failureTime,
      );
      await applyAgentCleanupIncident(
        tx,
        second,
        cleanup("exhausted", 1),
        failureTime,
      );
      await applyAgentCleanupIncident(
        tx,
        run,
        cleanup("released", 2),
        successTime,
      );
    });
    const [episode] = await db
      .select()
      .from(agentIncidentEpisodes)
      .where(eq(agentIncidentEpisodes.projectId, run.projectId!));

    expect(episode.state).toBe("open");
    await success(run, new Date("2026-10-01T01:20:00Z"));
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, episode.id))
      )[0].state,
    ).toBe("open");
    await db.transaction((tx) =>
      applyAgentCleanupIncident(
        tx,
        second,
        cleanup("released", 2),
        successTime,
      ),
    );
    expect(
      (
        await db
          .select()
          .from(agentIncidentEpisodes)
          .where(eq(agentIncidentEpisodes.id, episode.id))
      )[0].state,
    ).toBe("resolved");
  });
});
