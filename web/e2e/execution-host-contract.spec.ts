// ADR-166 (T6.2) — the execution-host contract end-to-end through the real UI +
// HTTP stack against the e2e test supervisor (global-setup):
//   U1 launching the task from the board PLACES the run: one registered local
//      host, `runs.execution_assignment_id` set, epoch 1 `launch`, and the
//      adopt → create → prompt commands on the ledger;
//   U2 the keep-alive sweeper checkpoints the permission-parked run (epoch 1
//      released `checkpointed`), the operator's answer resumes it under epoch
//      2 `resume` on the SAME adopted handle (no second adopt), and the run
//      finishes with every generation released.
//
// The test supervisor answers the fixture project's first prompt with a
// permission request, exits with reason "checkpoint" when the sweeper
// checkpoints it, and re-issues the request on the resumed session.
import { test, expect } from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { readLaunchResult } from "./_seed/launch-stream";
import { STUB_HOST_KEY } from "./_seed/stub-supervisor";

const CRON_HEADER = "X-Maister-Cron-Token";
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";

type AssignmentRow = [epoch: number, state: string, reason: string];

type CanonicalEventRow = {
  eventType: string;
  runSequence: string;
  payload: Record<string, unknown>;
};

type RuntimeObjectRow = {
  id: string;
  logicalName: string;
  mimeType: string;
  state: string;
  sha256: string;
};

async function runStatus(runId: string): Promise<string | null> {
  return singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
    runId,
  ]);
}

async function assignments(runId: string): Promise<AssignmentRow[]> {
  const rows = await singleValue<AssignmentRow[]>(
    `SELECT COALESCE(json_agg(json_build_array(epoch, state, placement_reason)
                              ORDER BY epoch), '[]'::json) AS value
       FROM execution_assignments WHERE run_id = $1`,
    [runId],
  );

  return rows ?? [];
}

async function commandRows(runId: string): Promise<
  Array<{
    kind: string;
    epoch: number;
    state: string;
    payload: Record<string, unknown>;
  }>
> {
  const rows = await singleValue<
    Array<{
      kind: string;
      epoch: number;
      state: string;
      payload: Record<string, unknown>;
    }>
  >(
    `SELECT COALESCE(json_agg(json_build_object(
              'kind', kind, 'epoch', assignment_epoch, 'state', state, 'payload', payload)
              ORDER BY created_at), '[]'::json) AS value
       FROM execution_commands WHERE run_id = $1`,
    [runId],
  );

  return rows ?? [];
}

async function canonicalEvents(runId: string): Promise<CanonicalEventRow[]> {
  const rows = await singleValue<CanonicalEventRow[]>(
    `SELECT COALESCE(json_agg(json_build_object(
              'eventType', event_type,
              'runSequence', run_sequence::text,
              'payload', payload)
              ORDER BY run_sequence), '[]'::json) AS value
       FROM execution_events
      WHERE run_id = $1 AND ingest_disposition = 'accepted'`,
    [runId],
  );

  return rows ?? [];
}

test("execution-host contract: board launch places the run; checkpoint + resume mint the next epoch on the same handle", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fx = loadFixtures().byKey.executionHost;

  // ---- U1: launch from the board. -------------------------------------
  await page.goto(`/projects/${fx.projectSlug}`);

  const launchControl = page
    .locator("[data-board]")
    .getByText("Execution host contract")
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "Launch", exact: true });

  await expect(launchControl).toBeVisible();
  await expect(launchControl).toBeEnabled();

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/runs") &&
      response.request().method() === "POST",
  );

  await launchControl.click();

  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();
  const createRun = dialog.getByRole("button", {
    name: "Create run",
    exact: true,
  });

  await expect(createRun).toBeEnabled();
  await createRun.click();

  const response = await launchResponse;

  expect(response.status()).toBe(200);
  const { runId } = await readLaunchResult(response);

  expect(runId).toBeTruthy();

  // The first prompt parks on the test supervisor's permission request.
  await expect
    .poll(() => runStatus(runId), { timeout: 60_000 })
    .toBe("NeedsInput");

  // Stage B: prompt admission is asynchronous. The command remains accepted
  // while HITL is pending, and the manager has already persisted the ordered
  // host stream as its canonical event source.
  await expect
    .poll(
      () =>
        canonicalEvents(runId).then((events) =>
          events.map((event) => event.eventType),
        ),
      { timeout: 30_000 },
    )
    .toEqual(
      expect.arrayContaining([
        "session.created",
        "session.command",
        "session.permission_request",
      ]),
    );
  const persistedEvents = await canonicalEvents(runId);
  const acceptedPrompt = persistedEvents.find(
    (event) =>
      event.eventType === "session.command" &&
      event.payload.kind === "session.prompt" &&
      event.payload.phase === "accepted",
  );

  expect(acceptedPrompt).toBeTruthy();
  expect(persistedEvents.map((event) => BigInt(event.runSequence))).toEqual(
    persistedEvents.map((_, index) => BigInt(index)),
  );
  expect(
    (await commandRows(runId)).find((row) => row.kind === "session.prompt")
      ?.state,
  ).toBe("accepted");

  // Browser replay exposes only the canonical, manager-owned event spine. It
  // deliberately omits host payloads and every filesystem locator.
  const browserEvent = await page.evaluate(
    ({ canonicalRunId }) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const source = new EventSource(
          `/api/runs/${canonicalRunId}/stream?lastEventId=0`,
        );
        const timer = window.setTimeout(() => {
          source.close();
          reject(new Error("canonical run stream did not replay an event"));
        }, 10_000);

        source.onmessage = (event) => {
          window.clearTimeout(timer);
          source.close();
          resolve(JSON.parse(event.data) as Record<string, unknown>);
        };
        source.onerror = () => {
          window.clearTimeout(timer);
          source.close();
          reject(new Error("canonical run stream failed"));
        };
      }),
    { canonicalRunId: runId },
  );

  expect(browserEvent.type).toBeTruthy();
  expect(browserEvent.runSequence).toBeTruthy();
  expect(browserEvent).not.toHaveProperty("payload");
  expect(JSON.stringify(browserEvent)).not.toMatch(
    /[\\/]runtime[\\/]|run\.events\.jsonl/,
  );

  // The manager catalog owns metadata; bytes remain behind an opaque,
  // authenticated run/object route and carry an end-to-end digest.
  const profileObject = await singleValue<RuntimeObjectRow>(
    `SELECT json_build_object(
              'id', id,
              'logicalName', logical_name,
              'mimeType', mime_type,
              'state', state,
              'sha256', sha256) AS value
       FROM execution_runtime_objects
      WHERE run_id = $1 AND kind = 'capability_profile'
      ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );

  expect(profileObject).toMatchObject({
    state: "available",
    mimeType: "application/json",
  });
  expect(profileObject?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(profileObject?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const profileContent = await request.get(
    `/api/runs/${runId}/runtime-objects/${profileObject?.id}/content`,
  );

  expect(profileContent.status()).toBe(200);
  expect(profileContent.headers()["content-digest"]).toMatch(/^sha-256=:/);
  expect(profileContent.headers()).not.toHaveProperty("x-runtime-path");
  const hitlRequestId = await singleValue<string>(
    `SELECT id AS value FROM hitl_requests
      WHERE run_id = $1 AND kind = 'permission' AND responded_at IS NULL`,
    [runId],
  );

  expect(hitlRequestId).toBeTruthy();

  // Placed on the ONE registered local host, under epoch 1 `launch`.
  const hosts = await singleValue<{ n: number; host_key: string }>(
    `SELECT json_build_object('n', count(*)::int, 'host_key', min(host_key)) AS value
       FROM execution_hosts WHERE kind = 'local_direct' AND retired_at IS NULL`,
    [],
  );

  expect(hosts).toEqual({ n: 1, host_key: STUB_HOST_KEY });
  expect(await assignments(runId)).toEqual([[1, "active", "launch"]]);
  const assignmentId = await singleValue<string>(
    `SELECT execution_assignment_id AS value FROM runs WHERE id = $1`,
    [runId],
  );

  expect(assignmentId).toBeTruthy();
  const workspaceHandle = await singleValue<string>(
    `SELECT execution_workspace_id AS value FROM execution_assignments
      WHERE id = $1`,
    [assignmentId],
  );

  expect(workspaceHandle).toMatch(/^ws_[0-9a-f]{32}$/);

  const launched = await commandRows(runId);

  expect(launched.map((c) => c.kind)).toEqual(
    expect.arrayContaining([
      "workspace.adopt",
      "session.create",
      "session.prompt",
    ]),
  );
  expect(launched.every((c) => c.epoch === 1)).toBe(true);

  // ---- U2: keep-alive expiry → sweeper checkpoint → idle. --------------
  await withE2EDb((pool) =>
    pool.query(
      `UPDATE runs SET keepalive_until = now() - interval '1 second' WHERE id = $1`,
      [runId],
    ),
  );
  // The system sweep (which hosts the keep-alive sweeper) is a scheduler job
  // on a 60 s cadence; make it due and tick it through the real cron route.
  await withE2EDb((pool) =>
    pool.query(
      `UPDATE scheduler_jobs SET next_run_at = now(), lease_expires_at = NULL
        WHERE job_kind = 'system_sweep'`,
    ),
  );
  const tick = await request.post("/api/cron/tick?jobKind=system_sweep", {
    headers: { [CRON_HEADER]: CRON_TOKEN },
  });

  expect([200, 207]).toContain(tick.status());

  await expect
    .poll(() => runStatus(runId), { timeout: 60_000 })
    .toBe("NeedsInputIdle");
  expect(await assignments(runId)).toEqual([[1, "released", "launch"]]);
  expect(
    (await commandRows(runId)).filter((c) => c.kind === "session.checkpoint"),
  ).toHaveLength(1);

  // The operator's answer on the idle run resumes it: epoch 2 `resume`, the
  // adopted handle copied forward (no second adopt), a create that resumes the
  // prior ACP session.
  const respond = await request.post(
    `/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
    { data: { optionId: "allow" } },
  );

  expect(respond.status()).toBe(202);

  await expect
    .poll(() => assignments(runId).then((rows) => rows.map((r) => r[0])), {
      timeout: 60_000,
    })
    .toEqual([1, 2]);
  const resumed = await assignments(runId);

  expect(resumed[1].slice(0, 1)).toEqual([2]);
  expect(resumed[1][2]).toBe("resume");
  expect(
    await singleValue<string>(
      `SELECT execution_workspace_id AS value FROM execution_assignments
        WHERE run_id = $1 AND epoch = 2`,
      [runId],
    ),
  ).toBe(workspaceHandle);

  const commands = await commandRows(runId);
  const creates = commands.filter((c) => c.kind === "session.create");

  expect(commands.filter((c) => c.kind === "workspace.adopt")).toHaveLength(1);
  expect(creates.map((c) => c.epoch)).toEqual([1, 2]);
  expect(creates[1].payload.resumeSessionId).toBeTruthy();

  // The resumed driver auto-delivers the stored answer and the graph finishes;
  // every generation is released at the end.
  await expect
    .poll(() => runStatus(runId), { timeout: 90_000 })
    .toMatch(/^(Review|Done)$/);
  await expect
    .poll(
      () =>
        commandRows(runId).then(
          (rows) => rows.find((row) => row.kind === "session.prompt")?.state,
        ),
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  await expect
    .poll(
      () =>
        canonicalEvents(runId).then((events) =>
          events.some(
            (event) =>
              event.eventType === "session.command" &&
              event.payload.kind === "session.prompt" &&
              event.payload.phase === "completed",
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(() => assignments(runId).then((rows) => rows.map((r) => r[1])), {
      timeout: 30_000,
    })
    .toEqual(["released", "released"]);
});
