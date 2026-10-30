import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  getAgentActivitySummaries,
  getAgentRunHistory,
  getAgentAttemptHistory,
  getActiveAgentExecutions,
} from "@/lib/agents/activity-queries";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const secret = process.env.AUTH_SECRET;

beforeAll(async () => {
  process.env.AUTH_SECRET = "activity-test-cursor-secret";
  database = await startMainPostgresTestDb({
    databaseName: "agent_activity_queries",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (secret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = secret;
});

describe("Retained agent activity", () => {
  it("IT-UX-06 batches retained counts and pages 10,000 frozen launches without admitting new rows into an existing cursor", async () => {
    const projectId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Activity','/unused/activity','ACTIVITY')",
      [projectId],
    );
    await database.pool.query(
      `INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,status,started_at,ended_at,activity_sort_at,activity_timestamp_provenance)
      SELECT gen_random_uuid()::text,$1,'fixture','agent','core:scan','Done',now()-interval '1 day',now()-interval '1 hour',date_trunc('milliseconds',now())-n*interval '1 microsecond','legacy_estimate'
      FROM generate_series(1,10000) n`,
      [projectId],
    );
    const queries: string[] = [];
    const logged = drizzle(database.pool, {
      schema,
      logger: {
        logQuery: (query) => {
          queries.push(query);
        },
      },
    });
    const summary = await getAgentActivitySummaries(logged, projectId, [
      "core:scan",
      "core:empty",
    ]);

    expect(queries).toHaveLength(1);
    expect(summary.get("core:scan")).toMatchObject({
      retainedRunCount: 10000,
      activeRunCount: 0,
      attemptCount: 0,
      lastLaunched: { status: "Done", estimated: true },
    });
    expect(summary.get("core:empty")).toMatchObject({
      retainedRunCount: 0,
      lastLaunched: null,
      lastCompleted: null,
    });
    const first = await getAgentRunHistory(database.db, {
      projectId,
      agentId: "core:scan",
      limit: 25,
    });

    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    await database.pool.query(
      "INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,status,activity_sort_at,activity_timestamp_provenance) VALUES ($1,$2,'fixture','agent','core:scan','Pending',clock_timestamp(),'legacy_estimate')",
      [randomUUID(), projectId],
    );
    const second = await getAgentRunHistory(database.db, {
      projectId,
      agentId: "core:scan",
      limit: 25,
      cursor: first.nextCursor!,
    });

    expect(second.items).toHaveLength(25);
    expect(second.asOf).toBe(first.asOf);
    expect(
      new Set([...first.items, ...second.items].map((row) => row.runId)).size,
    ).toBe(50);
    expect(second.items.every((row) => row.status === "Done")).toBe(true);
    for (const changed of [
      { projectId: randomUUID() },
      { agentId: "core:other" },
      { status: "Failed" as const },
      { cursor: first.nextCursor!.slice(0, -2) + "xx" },
    ]) {
      await expect(
        getAgentRunHistory(database.db, {
          projectId,
          agentId: "core:scan",
          cursor: first.nextCursor!,
          ...changed,
        }),
      ).rejects.toMatchObject({ code: "CONFIG" });
    }
    const plan = await database.pool.query<{ "QUERY PLAN": string }>(
      "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM runs WHERE project_id=$1 AND source_agent_id='core:scan' AND activity_sort_at<=now() ORDER BY activity_sort_at DESC,id DESC LIMIT 26",
      [projectId],
    );
    const explain = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

    expect(explain).toContain("runs_agent_activity_history_idx");
    process.stdout.write(
      JSON.stringify({
        testId: "IT-UX-06",
        retainedRows: 10000,
        pageSize: 25,
        summaryQueryCount: queries.length,
        explain,
      }) + "\n",
    );
  });

  it("IT-UX-07 IT-UX-10 exposes each active none/repo_read/flow launch without a workspace prerequisite and scopes every result to its supplied projects", async () => {
    const projectId = randomUUID();
    const foreignId = randomUUID();

    for (const id of [projectId, foreignId])
      await database.pool.query(
        "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Active',$2,$3)",
        [id, `/unused/${id}`, `ACT${id.slice(0, 8)}`],
      );
    const statuses = [
      "Pending",
      "Running",
      "NeedsInput",
      "NeedsInputIdle",
      "HumanWorking",
      "WaitingOnChildren",
      "Review",
      "Failed",
      "Crashed",
      "Done",
      "Abandoned",
    ];

    for (const status of statuses)
      await database.pool.query(
        "INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,status,activity_sort_at,activity_timestamp_provenance,agent_workspace) VALUES ($1,$2,'fixture',$3,'core:scan',$4,now(),'legacy_estimate',$5)",
        [
          randomUUID(),
          projectId,
          status === "Running" ? "flow" : "agent",
          status,
          status === "Running"
            ? null
            : status === "NeedsInput"
              ? "worktree"
              : statuses.indexOf(status) % 2
                ? "repo_read"
                : "none",
        ],
      );
    await database.pool.query(
      "INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,status,activity_sort_at,activity_timestamp_provenance) VALUES ($1,$2,'fixture','agent','core:scan','Running',now(),'legacy_estimate')",
      [randomUUID(), foreignId],
    );
    const rows = await getActiveAgentExecutions(database.db, [projectId]);

    expect(rows.map((row) => row.status).sort()).toEqual(
      statuses.slice(0, 6).sort(),
    );
    expect(
      rows.every(
        (row) => row.projectId === projectId && !row.workspaceAvailable,
      ),
    ).toBe(true);
    expect(rows.find((row) => row.status === "Running")).toMatchObject({
      runKind: "flow",
      pool: "flow",
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /repoPath|worktreePath|sessionId|prompt|triggerPayload/,
    );
    expect(await getActiveAgentExecutions(database.db, [])).toEqual([]);
    const waiting = rows.find((row) => row.status === "NeedsInput")!;

    await database.pool.query(
      "INSERT INTO workspaces(id,run_id,project_id,branch,worktree_path,parent_repo_path) VALUES ($1,$2,$3,'diagnostic',$4,'/unused/parent')",
      [randomUUID(), waiting.runId, projectId, `/unused/${waiting.runId}`],
    );
    for (const id of [randomUUID(), randomUUID()])
      await database.pool.query(
        "INSERT INTO hitl_requests(id,run_id,step_id,kind,prompt) VALUES ($1,$2,'agent-permission','permission','Allow operation?')",
        [id, waiting.runId],
      );
    expect(
      (await getActiveAgentExecutions(database.db, [projectId])).find(
        (row) => row.runId === waiting.runId,
      ),
    ).toMatchObject({ workspaceAvailable: true, pendingInputCount: 2 });
    await database.pool.query(
      "INSERT INTO runs(id,project_id,flow_version,run_kind,status) VALUES ($1,$2,'fixture','agent','Running')",
      [randomUUID(), projectId],
    );
    expect(
      (await getActiveAgentExecutions(database.db, [projectId])).filter(
        (row) => row.agentId === null,
      ),
    ).toHaveLength(1);
  });
  it("IT-UX-06 retains independently paged pre-run attempts and does not fabricate legacy lifetime totals", async () => {
    const projectId = randomUUID();
    const scheduleId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Attempts',$2,'ATTEMPTS')",
      [projectId, `/unused/${projectId}`],
    );
    for (const [index, provenance] of [
      "legacy_latest",
      "claim",
      "claim",
    ].entries()) {
      await database.pool.query(
        "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,fence,delivery_key,trigger_source,provenance,reserved_run_id,claimed_at,due_at,settled_at,outcome,reason_code) VALUES ($1,$2,'core:scan',$3,$4,$5,$6,'cron',$7,$8,date_trunc('milliseconds',now())-$5::integer*interval '1 second',now(),now(),'refused','runner_unavailable')",
        [
          randomUUID(),
          projectId,
          scheduleId,
          JSON.stringify({
            version: 1,
            scheduleId,
            triggerType: "cron",
            cronExpr: "* * * * *",
            timezone: "UTC",
            eventKinds: [],
          }),
          index + 1,
          `delivery-${index}`,
          provenance,
          randomUUID(),
        ],
      );
    }
    const summary = await getAgentActivitySummaries(database.db, projectId, [
      "core:scan",
    ]);

    expect(summary.get("core:scan")).toMatchObject({
      retainedRunCount: 0,
      attemptCount: null,
      lastLaunched: null,
    });
    const first = await getAgentAttemptHistory(database.db, {
      projectId,
      agentId: "core:scan",
      limit: 2,
    });
    const second = await getAgentAttemptHistory(database.db, {
      projectId,
      agentId: "core:scan",
      limit: 2,
      cursor: first.nextCursor!,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((row) => row.attemptId))
        .size,
    ).toBe(3);
    expect(
      [...first.items, ...second.items].every(
        (row) => row.runId === null && row.outcome === "refused",
      ),
    ).toBe(true);
    await expect(
      getAgentRunHistory(database.db, {
        projectId,
        agentId: "core:scan",
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
