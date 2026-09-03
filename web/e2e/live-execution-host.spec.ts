// ADR-165 (T6.2) — live-supervisor lane smoke of the execution-host contract:
//   S1 the REAL supervisor's /health carries its durable identity;
//   S2 a scratch launch through the UI against the real adapter is placed on
//      that host (epoch-1 assignment + an adopted workspace handle the host
//      still knows).
// Opt-in like the CCR live spec: the lane needs a real adapter + provider env.
import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

const SUPERVISOR_URL = `http://127.0.0.1:${process.env.MAISTER_SUPERVISOR_PORT ?? 7777}`;

test.skip(
  process.env.E2E_LIVE_SUPERVISOR !== "1",
  "live supervisor lane is opt-in; set E2E_LIVE_SUPERVISOR=1",
);

test("S1: the real supervisor's /health carries the execution-host identity", async ({
  request,
}) => {
  const res = await request.get(`${SUPERVISOR_URL}/health`);

  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    status: string;
    host?: { hostKey?: string; bootId?: string; protocolVersion?: number };
  };

  expect(body.status).toBe("ready");
  expect(body.host?.hostKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(body.host?.bootId).toBeTruthy();
  expect(body.host?.protocolVersion).toBe(1);

  // The web tier registered exactly that host (ADR-165 D1).
  const registered = await singleValue<string>(
    `SELECT host_key AS value FROM execution_hosts
      WHERE kind = 'local_direct' AND retired_at IS NULL`,
    [],
  );

  expect(registered).toBe(body.host?.hostKey);
});

test("S2: a live scratch launch is placed on the host with an adopted workspace handle", async ({
  page,
  request,
}) => {
  const fx = loadFixtures().byKey.scratch;
  const branchName = `${fx.projectSlug}/scratch/live-eh-${Date.now()}`;

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);
  await expect(
    page.getByRole("heading", { name: "Start a scratch run." }),
  ).toBeVisible();
  await page.getByLabel("Workspace name").fill("Live execution-host smoke");
  await page.getByLabel("Branch name").fill(branchName);
  await page
    .getByLabel("What do you want to do?")
    .fill("Reply with one short sentence confirming the execution-host smoke.");

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scratch-runs") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Launch scratch run" }).click();
  expect([201, 202]).toContain((await launchResponse).status());
  await page.waitForURL(/\/scratch-runs\/[0-9a-f-]+/, { timeout: 120_000 });

  const runId = page.url().match(/\/scratch-runs\/([0-9a-f-]+)/)?.[1];

  expect(runId).toBeTruthy();

  const assignment = await expect
    .poll(
      () =>
        singleValue<{
          epoch: number;
          state: string;
          placement_reason: string;
          execution_workspace_id: string | null;
        }>(
          `SELECT json_build_object(
              'epoch', epoch, 'state', state, 'placement_reason', placement_reason,
              'execution_workspace_id', execution_workspace_id) AS value
             FROM execution_assignments WHERE run_id = $1 ORDER BY epoch DESC LIMIT 1`,
          [runId],
        ),
      { timeout: 60_000 },
    )
    .toMatchObject({ epoch: 1, placement_reason: "launch" })
    .then(() =>
      singleValue<{ execution_workspace_id: string | null }>(
        `SELECT json_build_object('execution_workspace_id', execution_workspace_id) AS value
           FROM execution_assignments WHERE run_id = $1 ORDER BY epoch DESC LIMIT 1`,
        [runId],
      ),
    );

  expect(assignment?.execution_workspace_id).toMatch(/^ws_[0-9a-f]{32}$/);

  // The host still knows the adopted handle (path-free projection).
  const workspace = await request.get(
    `${SUPERVISOR_URL}/workspaces/${assignment?.execution_workspace_id}`,
  );

  expect(workspace.status()).toBe(200);
  expect(await workspace.json()).toMatchObject({
    executionWorkspaceId: assignment?.execution_workspace_id,
    runId,
    releasedAt: null,
  });
});
