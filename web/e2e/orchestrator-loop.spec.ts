// M36 (ADR-095) — the orchestrator delegate→park→resume loop, end-to-end in the
// browser against the REAL HTTP stack. The board Launch creates an orchestrator
// FLOW run; the test supervisor (e2e/_seed/test-supervisor.ts, wired in
// global-setup) simulates the coordinator's agent session and spawns 2 children
// through the REAL ext /api/v1/ext/runs/delegate route (Next IS served here, so
// — unlike the node loop test's direct-service substitution — this exercises the
// real HTTP ext route + token auth). The orchestrator parks on
// WaitingOnChildren; the workbench renders the dynamic run-tree subtree with its
// 2 children. The children are then released + the domain-event dispatcher is
// ticked (POST /api/cron/tick?jobKind=domain_event_dispatch) so the
// orchestrator_resume consumer wakes the parked coordinator, which resumes over
// the real wire and the run reaches a terminal/promoted state (Review).
//
// CI-ONLY: requires a free :3100 (the playwright webServer). It cannot run while
// a `next dev` holds the Next 16 single-dev lock on the same project dir.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { STUB_SESSIONS_DIR } from "./_seed/stub-supervisor";

const CRON_HEADER = "X-Maister-Cron-Token";
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";

// The test supervisor writes a `<sessionId>.json` per non-orchestrator (child)
// session and holds its stream until a `<sessionId>.release` marker — release
// every pending child so the workspace=none children finalize Done.
function releaseAllChildSessions(seenRunIds: Set<string>): string[] {
  if (!existsSync(STUB_SESSIONS_DIR)) return [];
  const released: string[] = [];

  for (const name of readdirSync(STUB_SESSIONS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const rec = JSON.parse(
      readFileSync(path.join(STUB_SESSIONS_DIR, name), "utf8"),
    ) as { sessionId: string; request?: { runId?: string } };
    const runId = rec.request?.runId;

    if (!runId || !seenRunIds.has(runId)) continue;
    const marker = path.join(STUB_SESSIONS_DIR, `${rec.sessionId}.release`);

    if (!existsSync(marker)) {
      writeFileSync(marker, "go", "utf8");
      released.push(rec.sessionId);
    }
  }

  return released;
}

test("orchestrator loop: launch → park with child subtree → resume to terminal", async ({
  page,
  request,
}) => {
  const fx = loadFixtures().byKey.orchestrator;

  // ---- Launch the orchestrator task from the board. ------------------------
  await page.goto(`/projects/${fx.projectSlug}`);

  const launchControl = page
    .locator("[data-board]")
    .getByText("Coordinate the delivery")
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "Run again", exact: true });

  await expect(launchControl).toBeVisible();
  await expect(launchControl).toBeEnabled();

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/runs") &&
      response.request().method() === "POST",
  );

  await launchControl.click();
  // The launch popover confirm (mirrors the board "Run again" → confirm flow).
  const confirm = page.getByRole("button", { name: "Launch", exact: true });

  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }

  const response = await launchResponse;

  expect([200, 201, 202]).toContain(response.status());
  const { runId } = (await response.json()) as { runId: string };

  expect(runId).toBeTruthy();

  // ---- The orchestrator parks on WaitingOnChildren with 2 children. --------
  // The coordinator session spawns 2 children via the real ext delegate route,
  // then the node parks (pending children).
  await expect
    .poll(
      () =>
        singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
          runId,
        ]),
      { timeout: 30_000 },
    )
    .toBe("WaitingOnChildren");

  const childRunIds = await singleValue<string>(
    `SELECT string_agg(id::text, ',') AS value FROM runs WHERE parent_run_id = $1`,
    [runId],
  );
  const childIds = (childRunIds ?? "").split(",").filter(Boolean);

  expect(childIds).toHaveLength(2);

  // ---- The workbench renders the dynamic run-tree subtree (Phase 6). -------
  await page.goto(`/runs/${runId}`);
  const subtree = page.getByTestId("orchestrator-run-subtree");

  await expect(subtree).toBeVisible();
  // Two subordinate child cards, each carrying the delegation target agent id.
  await expect(subtree.locator("[data-child-run-id]")).toHaveCount(2);
  await expect(
    subtree.getByTestId("orchestrator-child-agent").first(),
  ).toContainText(fx.workerAgentId);

  // ---- Drive the resume: release children, then tick the dispatcher. -------
  // Children land Running under the agent cap; each child's held stream is
  // released as its session file appears (a child session is created only once
  // startAgentSession runs). Keep releasing until BOTH children finalize Done
  // (workspace=none → run.done with the parent linkage).
  const seen = new Set(childIds);

  await expect
    .poll(
      async () => {
        releaseAllChildSessions(seen);

        return singleValue<string>(
          `SELECT count(*)::text AS value FROM runs WHERE parent_run_id = $1 AND status = 'Done'`,
          [runId],
        );
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe("2");

  // Tick the domain-event dispatcher → the orchestrator_resume consumer wakes
  // the parked coordinator → real runFlow resume over the real wire → terminal.
  await expect
    .poll(
      async () => {
        await request.post("/api/cron/tick?jobKind=domain_event_dispatch", {
          headers: { [CRON_HEADER]: CRON_TOKEN },
        });

        return singleValue<string>(
          `SELECT status AS value FROM runs WHERE id = $1`,
          [runId],
        );
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe("Review");

  // The full loop closed: orchestrator Review, both children Done, no stuck slot.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value FROM runs WHERE status IN ('Running','Pending','WaitingOnChildren') AND (id = $1 OR parent_run_id = $1)`,
      [runId],
    ),
  ).toBe("0");
});
