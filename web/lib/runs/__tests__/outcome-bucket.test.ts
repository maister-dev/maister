import { describe, expect, it } from "vitest";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import { WORK_IN_FLIGHT_STAGES } from "@/lib/work/stage";
import {
  BUCKET_BY_RUN_STATUS,
  IN_FLIGHT_OUTCOME_BUCKETS,
  RUN_OUTCOME_BUCKETS,
  SETTLED_OUTCOME_BUCKETS,
  TASK_IN_WORK_SETTLED_STATUSES,
  isRunOutcomeBucket,
} from "@/lib/runs/outcome-bucket";

describe("run outcome buckets (ADR-177 D3)", () => {
  it("has exactly the ten D3 members, in-flight first", () => {
    expect(RUN_OUTCOME_BUCKETS).toEqual([
      "Queued",
      "Executing",
      "WaitingOnHuman",
      "Review",
      "Crashed",
      "Delivered",
      "PrOpen",
      "ResultOnly",
      "Failed",
      "Abandoned",
    ]);
    expect(RUN_OUTCOME_BUCKETS).toHaveLength(10);
  });

  it("names its in-flight subset exactly as WORK_IN_FLIGHT_STAGES", () => {
    expect([...IN_FLIGHT_OUTCOME_BUCKETS]).toEqual([...WORK_IN_FLIGHT_STAGES]);
  });

  it("partitions the ten buckets into in-flight and settled with no overlap", () => {
    expect([...IN_FLIGHT_OUTCOME_BUCKETS, ...SETTLED_OUTCOME_BUCKETS]).toEqual([
      ...RUN_OUTCOME_BUCKETS,
    ]);
    expect(
      IN_FLIGHT_OUTCOME_BUCKETS.filter((bucket) =>
        (SETTLED_OUTCOME_BUCKETS as readonly string[]).includes(bucket),
      ),
    ).toEqual([]);
  });

  it("maps every run status — a twelfth status is a compile error", () => {
    expect(Object.keys(BUCKET_BY_RUN_STATUS).sort()).toEqual(
      [...RUN_STATUS_VALUES].sort(),
    );

    for (const status of RUN_STATUS_VALUES) {
      expect(RUN_OUTCOME_BUCKETS).toContain(BUCKET_BY_RUN_STATUS[status]);
    }
  });

  it("maps the base statuses per the D3 table", () => {
    expect(BUCKET_BY_RUN_STATUS).toEqual({
      Pending: "Queued",
      Running: "Executing",
      WaitingOnChildren: "Executing",
      NeedsInput: "WaitingOnHuman",
      NeedsInputIdle: "WaitingOnHuman",
      HumanWorking: "WaitingOnHuman",
      Review: "Review",
      Crashed: "Crashed",
      Done: "Delivered",
      Failed: "Failed",
      Abandoned: "Abandoned",
    });
  });

  it("narrows an unknown bucket string", () => {
    expect(isRunOutcomeBucket("Delivered")).toBe(true);
    expect(isRunOutcomeBucket("delivered")).toBe(false);
    expect(isRunOutcomeBucket("Promoted")).toBe(false);
  });

  it("keeps the task-overlap settled set distinct from the orchestrator one", () => {
    // Review and Crashed are NOT settled for a task: a crashed run owes a
    // recover/discard decision and a Review run awaits promotion.
    expect(TASK_IN_WORK_SETTLED_STATUSES).toEqual([
      "Done",
      "Failed",
      "Abandoned",
    ]);
    expect(TASK_IN_WORK_SETTLED_STATUSES).not.toContain("Review");
    expect(TASK_IN_WORK_SETTLED_STATUSES).not.toContain("Crashed");
  });
});

describe("runOutcomeBucketSql", () => {
  // Rendered through drizzle's OWN dialect, so the assertion reads the SQL the
  // database would receive rather than a hand-rolled approximation of it.
  async function render(): Promise<{ text: string; params: unknown[] }> {
    const { runOutcomeBucketSql } = await import("@/lib/runs/outcome-bucket");
    const { sql } = await import("drizzle-orm");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const query = new PgDialect().sqlToQuery(
      runOutcomeBucketSql({
        status: sql`r.status`,
        promotionState: sql`w.promotion_state`,
        promotionMode: sql`w.promotion_mode`,
        prState: sql`w.pr_state`,
        removedAt: sql`w.removed_at`,
      }),
    );

    return { text: query.sql, params: query.params };
  }

  it("emits exactly one arm per run status, in map order, bound as parameters", async () => {
    const { text, params } = await render();
    const { BUCKET_BY_RUN_STATUS: map } = await import(
      "@/lib/runs/outcome-bucket"
    );

    // Pairwise: every status arm binds (status, its bucket) and nothing else.
    // Read as pairs rather than by `indexOf`, because several statuses are also
    // bucket names and a first-match lookup would land on the wrong slot.
    expect(params).toEqual(
      RUN_STATUS_VALUES.flatMap((status) => [status, map[status]]),
    );

    const arms = [...text.matchAll(/r\.status = \$(\d+) THEN \$(\d+)/g)];

    expect(arms).toHaveLength(RUN_STATUS_VALUES.length);
    // 11 status arms + the 4 refinement arms, and nothing else.
    expect(text.split("WHEN ").length - 1).toBe(RUN_STATUS_VALUES.length + 4);
    expect(text.startsWith("CASE ")).toBe(true);
    expect(text.endsWith(" END")).toBe(true);
  });

  it("refines Done and a removed workspace with inline, non-parameterized arms", async () => {
    const { text } = await render();

    expect(text).toContain(
      "WHEN r.status IN ('Review', 'Crashed') AND w.removed_at IS NOT NULL THEN 'Abandoned'",
    );
    expect(text).toContain(
      "WHEN r.status = 'Done' AND (w.promotion_state IS NULL OR w.promotion_state = 'none') THEN 'ResultOnly'",
    );
    expect(text).toContain(
      "WHEN r.status = 'Done' AND w.promotion_mode = 'pull_request' AND w.pr_state = 'closed' THEN 'Abandoned'",
    );
    expect(text).toContain(
      "WHEN r.status = 'Done' AND w.promotion_mode = 'pull_request' AND (w.pr_state IS NULL OR w.pr_state = 'open') THEN 'PrOpen'",
    );
  });

  it("tests every refinement BEFORE the plain status map", async () => {
    const { text } = await render();

    // A refined row must never fall through to its base bucket, so the last
    // refinement arm precedes the first generated status arm.
    expect(text.lastIndexOf("THEN 'PrOpen'")).toBeLessThan(
      text.indexOf("r.status = $"),
    );
  });
});
