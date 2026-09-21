import type { GlobalRole } from "@/lib/db/schema";

import { describe, expect, it, vi } from "vitest";

import {
  listRunsPage,
  normalizeRunsListFilters,
} from "@/lib/queries/runs-list";
import { filtersToParams } from "@/lib/runs/list-params";

function sqlDebugText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlDebugText).join(" ");
  if (value && typeof value === "object") {
    const object = value as {
      queryChunks?: unknown[];
      value?: unknown;
    };

    return [object.value, object.queryChunks].map(sqlDebugText).join(" ");
  }

  return "";
}

describe("runs list query", () => {
  it("normalizes URL filters for the runs ledger", () => {
    const filters = normalizeRunsListFilters({
      agent: "claude",
      bucket: "Delivered",
      from: "2026-06-01",
      kind: "flow",
      page: "3",
      project: ["alpha", "ignored"],
      source: "scheduled",
      status: "Running",
      to: "2026-06-20",
    });

    expect(filters).toEqual({
      agent: "claude",
      bucket: "Delivered",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-20",
      kind: "flow",
      page: 3,
      projectSlug: "alpha",
      source: "scheduled",
      status: "Running",
    });
  });

  it("drops unknown kind and bucket values instead of widening the query", () => {
    expect(
      normalizeRunsListFilters({ kind: "everything", bucket: "Promoted" }),
    ).toEqual({ page: 1 });
    // `Promoted` is a WorkStage, not an ADR-178 bucket — the ledger must not
    // accept it just because it reads like one.
    expect(normalizeRunsListFilters({ bucket: "delivered" })).toEqual({
      page: 1,
    });
  });

  it("round-trips kind and bucket through the shared param builder", () => {
    const params = filtersToParams({
      page: 1,
      projectSlug: "alpha",
      kind: "scratch",
      bucket: "PrOpen",
      dateFrom: "2026-05-07",
      dateTo: "2026-06-05",
    });

    expect(params.toString()).toBe(
      "project=alpha&kind=scratch&bucket=PrOpen&from=2026-05-07&to=2026-06-05",
    );
    expect(normalizeRunsListFilters(Object.fromEntries(params))).toEqual({
      page: 1,
      projectSlug: "alpha",
      kind: "scratch",
      bucket: "PrOpen",
      dateFrom: "2026-05-07",
      dateTo: "2026-06-05",
    });
  });

  it("drops unsupported URL filters instead of widening the query", () => {
    const filters = normalizeRunsListFilters({
      agent: "unknown-agent",
      from: "not-a-date",
      page: "-10",
      source: "everything",
      status: "Exploded",
      to: "2026-13-40",
    });

    expect(filters).toEqual({ page: 1 });
  });

  it("maps scheduled run rows into ledger entries with detail links", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "project-1",
            project_name: "Website",
            project_slug: "web",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ total_count: "1" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            agent_id: null,
            branch: "maister/TASK-7",
            cache_creation_tokens: 2,
            cache_read_tokens: 3,
            capability_agent: "claude",
            cutover_failed_at: "2026-06-20T10:05:00.000Z",
            ended_at: "2026-06-20T10:05:00.000Z",
            flow_ref_id: "aif-implement",
            flow_version: "v1.2.0",
            input_tokens: 5,
            output_tokens: 7,
            project_id: "project-1",
            project_name: "Website",
            project_slug: "web",
            run_id: "run-1",
            run_kind: "flow",
            runner_snapshot: {
              adapter: "claude",
              id: "runner-1",
              model: "claude-sonnet",
              providerKind: "anthropic",
            },
            schedule_id: "schedule-1",
            schedule_name: "Nightly build",
            started_at: "2026-06-20T10:00:00.000Z",
            status: "Done",
            task_number: 7,
            task_title: "Ship landing page",
            task_key: "WEB",
            trigger_source: null,
          },
        ],
      });

    const page = await listRunsPage({
      db: { execute },
      filters: { page: 1, source: "scheduled" },
      pageSize: 25,
      user: { id: "user-1", role: "member" as GlobalRole },
    });

    expect(page.projectOptions).toEqual([
      { id: "project-1", name: "Website", slug: "web" },
    ]);
    expect(page.rows).toEqual([
      expect.objectContaining({
        branch: "maister/TASK-7",
        cutoverFailedAt: new Date("2026-06-20T10:05:00.000Z"),
        durationMs: 300_000,
        flowLabel: "aif-implement · v1.2.0",
        href: "/runs/run-1",
        projectSlug: "web",
        runId: "run-1",
        sourceKind: "scheduled",
        sourceLabel: "Nightly build",
        taskLabel: "WEB-7 Ship landing page",
        tokensTotal: 17,
      }),
    ]);
    expect(page.hasNextPage).toBe(false);
    expect(page.pageCount).toBe(1);
    expect(page.totalRows).toBe(1);
  });

  it("keeps member visibility and workspace joins in the generated query", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await listRunsPage({
      db: { execute },
      filters: { page: 1 },
      pageSize: 25,
      user: { id: "user-1", role: "member" as GlobalRole },
    });

    const queryTexts = execute.mock.calls.map((call) => sqlDebugText(call[0]));
    // Both the page and the count query carry the workspace lateral now
    // (ADR-178 D8 filters on its columns), so select the page query by the
    // pagination clause only it has.
    const runsQueryText =
      queryTexts.find((text) => text.includes("OFFSET")) ?? "";
    const countQueryText =
      queryTexts.find((text) => text.includes("count(*)")) ?? "";

    expect(runsQueryText).toContain("project_members");
    expect(runsQueryText).toContain("pm.user_id");
    expect(runsQueryText).toContain("LEFT JOIN LATERAL");
    expect(runsQueryText).toContain("FROM workspaces w");
    expect(runsQueryText).toContain("LIMIT 1");
    expect(runsQueryText).toContain("de.occurred_at AS failed_at");
    expect(runsQueryText).not.toContain("de.created_at AS failed_at");
    expect(countQueryText).toContain("LEFT JOIN LATERAL");
    expect(countQueryText).toContain("FROM run_schedules s");
  });

  it("gives the count query the same workspace lateral the bucket filter reads", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await listRunsPage({
      db: { execute },
      filters: { page: 1, bucket: "Delivered", kind: "flow" },
      pageSize: 25,
      user: { id: "user-1", role: "admin" as GlobalRole },
    });

    const queryTexts = execute.mock.calls.map((call) => sqlDebugText(call[0]));
    const countQueryText =
      queryTexts.find((text) => text.includes("count(*)")) ?? "";

    // Without the lateral, `w.promotion_state` in the predicate is a SQL error
    // — and a count that disagrees with the page is worse than an error.
    expect(countQueryText).toContain("FROM workspaces w");
    expect(countQueryText).toContain("w.promotion_state");
    expect(countQueryText).toContain("r.run_kind =");
  });
});
