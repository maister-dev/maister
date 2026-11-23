import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { readStubSessionRecords } from "./_seed/session-records";
import {
  E2E_HOLD_TURN_MARKER,
  STUB_SESSIONS_DIR,
} from "./_seed/stub-supervisor";
import { withE2EDb, seedDefaultRunSession } from "./_seed/db";
import { seedOperationalStopAgent } from "./_seed/operational-stop-agent";
import contract from "./_seed/operational-contract.json" with { type: "json" };
import {
  seedManualTaskLaunchFixture,
  manualQualifierCheckoutPath,
} from "./_seed/manual-task-launch";

import { git } from "@/test-support/git-fixture";

// Browser wiring only. The real supervisor/Postgres integration suites own
// outcome classification, permissions, source integrity and physical cleanup.
const projectId = randomUUID();
const slug = `operational-ui-${projectId.slice(0, 8)}`;
const agentId = `fixture:operational-${projectId.slice(0, 8)}`;
const successId = randomUUID();
const performedId = randomUUID();
const failedId = randomUUID();
const codeId = randomUUID();

test.describe("operational results, history and attention", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    await withE2EDb(async (pool) => {
      await pool.query(
        `INSERT INTO projects (id,slug,name,repo_path,maister_yaml_path,task_key) VALUES ($1,$2,'Operational UI',$3,'/tmp/maister.yaml',$4)`,
        [
          projectId,
          slug,
          `/tmp/${slug}`,
          `OU${projectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
        ],
      );
      await pool.query(
        `INSERT INTO agents (id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,kind,completion_contract) VALUES ($1,'fixture','v1','git','Operational intake','Import','worktree','session','["cron"]','standard','/tmp/operation.md','operational','{"contract":"operational_v1"}')`,
        [agentId],
      );
      await pool.query(
        `INSERT INTO agent_project_links (id,project_id,agent_id) VALUES ($1,$2,$3)`,
        [randomUUID(), projectId, agentId],
      );
      for (const [id, status, operational] of [
        [successId, "Done", true],
        [performedId, "Done", true],
        [failedId, "Failed", true],
        [codeId, "Review", false],
      ] as const) {
        const success = status === "Done";
        const performed = id === performedId;
        const value = {
          schemaVersion: 1,
          outcome: success ? "success" : "blocked",
          summary: performed
            ? "External operation completed."
            : success
              ? "Complete scan; no new work."
              : "GitHub denied the scan.",
          coverage: {
            state: success ? "complete" : "not_started",
            remainingKnown: success ? 0 : null,
          },
          counts: {
            scanned: performed ? 1 : 0,
            attempted: performed ? 1 : 0,
            completed: performed ? 1 : 0,
            failed: 0,
            skipped: 0,
            created: 0,
          },
          references: [],
          diagnostics: success
            ? []
            : [
                {
                  code: "github_http_403",
                  severity: "error",
                  operation: "list_issues",
                  message: "GitHub returned HTTP 403.",
                  retryable: false,
                  remediation:
                    "Restore repository issue access, then start a new attempt.",
                  service: "github",
                  httpStatus: 403,
                },
              ],
        };
        const terminal = {
          version: 1,
          status,
          cause: "agent_exit",
          effectiveOutcome: value.outcome,
          successful: success,
          validation: "valid",
          integrity: "clean",
          baselineGeneration: 1,
          resultRevision: 1,
          reasonCodes: success ? [] : ["reported_blocked"],
          evidenceIds: [],
        };
        const cleanup = {
          version: 1,
          resourceKind: "worktree",
          workspace: "worktree",
          state: success ? "released" : "exhausted",
          revision: 6,
          armedAt: new Date().toISOString(),
          attempts: 5,
          dueAt: null,
          errorCode: success ? null : "operational_preservation_failed",
          evidenceIds: [],
          removedAt: success ? new Date().toISOString() : null,
          releasedAt: success ? new Date().toISOString() : null,
          lease: null,
          rearmReceipt: null,
        };
        // Result publication and the exact terminal receipt share one tx, as in
        // production; deferred SQL guards reject a fabricated success.
        const connection = await pool.connect();

        try {
          await connection.query("BEGIN");
          await connection.query(
            `INSERT INTO runs (id,project_id,run_kind,agent_id,agent_kind,agent_workspace,status,flow_version,result_contract,operational_terminal,operational_cleanup,ended_at) VALUES ($1,$2,'agent',$3,$4,'worktree',$5,'agent',$6::jsonb,$7::jsonb,$8::jsonb,now())`,
            [
              id,
              projectId,
              operational ? agentId : null,
              operational ? "operational" : "code_delivery",
              status,
              operational ? JSON.stringify(contract) : null,
              operational ? JSON.stringify(terminal) : null,
              operational ? JSON.stringify(cleanup) : null,
            ],
          );
          if (operational)
            await connection.query(
              `INSERT INTO run_results (id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,engine_version) VALUES ($1,$2,1,'valid',$3,1,$4,$5::jsonb,$6,'agent_session','session:default','3.9.0')`,
              [
                randomUUID(),
                id,
                contract.schemaRef,
                contract.sha256,
                JSON.stringify(value),
                Buffer.byteLength(JSON.stringify(value)),
              ],
            );
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
        await pool.query(
          `INSERT INTO workspaces (id,project_id,run_id,branch,worktree_path,parent_repo_path,removed_at,scheduled_removal_at,removal_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,null,$8)`,
          [
            randomUUID(),
            projectId,
            id,
            `maister/${id}`,
            `/tmp/${slug}/${id}`,
            `/tmp/${slug}`,
            success ? new Date() : null,
            success ? "retention_gc" : null,
          ],
        );
        await seedDefaultRunSession(pool, {
          runId: id,
          runnerId: null,
          capabilityAgent: "claude",
        });
      }
      await pool.query(
        `INSERT INTO agent_schedules (id,project_id,agent_id,trigger_type,cron_expr,timezone,next_fire_at,last_outcome,last_run_id) VALUES ($1,$2,$3,'cron','0 * * * *','UTC',now()+interval '1 day','launched',$4)`,
        [randomUUID(), projectId, agentId, failedId],
      );
    });
  });
  test.afterAll(async () => {
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
      await pool.query("DELETE FROM agents WHERE id=$1", [agentId]);
    });
  });

  for (const locale of ["en", "ru"] as const) {
    test(`IT-OPA-06 operational result and action wiring (${locale})`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(`/runs/${successId}`);
      const result = page.locator('[data-testid="operational-result"]:visible');

      await expect(result).toBeInViewport();
      await expect(
        page.getByTestId("run-outcome").filter({ visible: true }),
      ).toBeInViewport();
      await expect(
        page.locator('[data-testid="operational-outcome"]:visible'),
      ).toHaveText(locale === "en" ? "Done" : "Готово");
      await expect(result).toContainText(
        locale === "en" ? "no new work" : "новой работы нет",
      );
      await expect(
        page.getByRole("link", { name: /^(Files|Diff|Файлы|Изменения)$/ }),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-testid="agent-run-review-cta"]:visible'),
      ).toHaveCount(0);
      await page.goto(`/runs/${performedId}`);
      await expect(
        page.locator('[data-testid="operational-result"]:visible'),
      ).toContainText("External operation completed.");
      await expect(
        page.locator('[data-testid="operational-result"]:visible'),
      ).not.toContainText(locale === "en" ? "no new work" : "новой работы нет");
      await page.goto(`/runs/${failedId}`);
      await expect(
        page.locator('[data-testid="operational-result"]:visible'),
      ).toContainText("HTTP 403");
      await expect(
        page.locator('[data-testid="operational-result"]:visible'),
      ).toContainText("Restore repository issue access");
      await expect(
        page.getByRole("button", {
          name:
            locale === "en"
              ? "Retry workspace cleanup"
              : "Повторить очистку рабочей области",
        }),
      ).toBeVisible();
      await page.goto(`/projects/${slug}`);
      await expect(page.locator(`a[href='/runs/${failedId}']`)).toHaveCount(0);
      await expect(page.locator(`a[href='/runs/${successId}']`)).toHaveCount(0);
      await expect(
        page.locator(`a[href='/runs/${codeId}']`).first(),
      ).toBeVisible();
      await page.goto(`/projects/${slug}?tab=automations`);
      await expect(
        page.locator(`a[href='/runs/${failedId}']`).first(),
      ).toBeVisible();
      await page.goto(`/runs/${codeId}`);
      await expect(
        page.getByTestId("run-outcome").filter({ visible: true }),
      ).toBeInViewport();
      await expect(
        page.locator('[data-testid="agent-run-review-cta"]:visible'),
      ).toBeVisible();
    });
  }

  test("IT-OPL-02 active operational execution retains Stop without delivery actions", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    const fixture = await seedManualTaskLaunchFixture();
    const liveAgentId = await seedOperationalStopAgent(fixture);
    const launch = await page.request.post(
      `/api/projects/${fixture.slug}/agents/${encodeURIComponent(liveAgentId)}/launch`,
      { headers: { Origin: new URL(baseURL!).origin }, data: {} },
    );

    expect(launch.status(), await launch.text()).toBe(202);
    const { runId: runningId } = (await launch.json()) as { runId: string };

    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (
                await pool.query(
                  "SELECT r.status,(SELECT count(*)::int FROM execution_commands c WHERE c.run_id=r.id AND c.kind='session.prompt') AS prompt_commands,(SELECT count(*)::int FROM run_session_incarnations i WHERE i.run_id=r.id AND i.state='active') AS active_incarnations FROM runs r WHERE r.id=$1",
                  [runningId],
                )
              ).rows[0],
          ),
        { timeout: 20_000 },
      )
      .toMatchObject({
        status: "Running",
        prompt_commands: 1,
        active_incarnations: 1,
      });
    await page.goto(`/runs/${runningId}`);
    const actions = page.locator(
      '[data-testid="workbench-lifecycle-actions"]:visible',
    );

    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button")).toHaveText(["Stop"]);
    await expect(page.getByTestId("workbench-git-open")).toHaveCount(0);
    await actions.getByRole("button", { name: "Stop", exact: true }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          res.url().endsWith(`/api/runs/${runningId}/stop`),
      ),
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click(),
    ]);

    const stopFacts = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            `SELECT r.id,r.status,r.execution_assignment_id,
            (SELECT jsonb_agg(jsonb_build_object('id',i.id,'state',i.state,'hostSessionId',i.host_session_id,'assignmentId',i.execution_assignment_id,'epoch',i.assignment_epoch)) FROM run_session_incarnations i WHERE i.run_id=r.id) AS incarnations,
            (SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'state',c.state,'epoch',c.assignment_epoch,'receiptPhase',c.receipt_evidence->>'phase','httpStatus',c.receipt_evidence->>'httpStatus')) FROM execution_commands c WHERE c.run_id=r.id) AS commands,
            (SELECT jsonb_agg(jsonb_build_object('type',e.event_type,'hostSessionId',e.host_session_id,'epoch',e.assignment_epoch,'receivedAt',e.received_at)) FROM execution_events e WHERE e.run_id=r.id AND e.event_type IN ('session.created','session.exited','session.crashed','session.checkpointed')) AS lifecycle
            FROM runs r WHERE r.id=$1`,
            [runningId],
          )
        ).rows[0],
    );

    await test.info().attach("operational-stop-facts", {
      body: JSON.stringify(stopFacts),
      contentType: "application/json",
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
    });
    await expect(
      page.locator('[data-testid="operational-outcome"]:visible'),
    ).toHaveText("Cancelled");
    await expect(actions).toHaveCount(0);
    await withE2EDb(async (pool) => {
      const result = await pool.query(
        "SELECT status, operational_cleanup->>'state' AS cleanup FROM runs WHERE id=$1",
        [runningId],
      );

      expect(result.rows).toEqual([
        { status: "Abandoned", cleanup: "released" },
      ]);
    });
  });

  test("IT-OPL-02 browser actions acknowledge a failure and rearm only workspace cleanup", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await page.goto(`/runs/${failedId}`);
    // A cleanup worker can advance the revision after the page was rendered.
    // The refusal must show localized feedback, and a refreshed retry must
    // still show its own success feedback through the shared provider.
    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE runs SET operational_cleanup=jsonb_set(operational_cleanup, '{revision}', '7') WHERE id=$1",
        [failedId],
      );
    });
    const [stale] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith(`/api/runs/${failedId}/operational/cleanup/retry`),
      ),
      page
        .getByRole("button", { name: "Retry workspace cleanup", exact: true })
        .click(),
    ]);

    expect(stale.status()).toBe(409);
    await expect(
      page.getByText(
        "Action failed. Refresh and review the current revision.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    const [retry] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith(`/api/runs/${failedId}/operational/cleanup/retry`),
      ),
      page
        .getByRole("button", { name: "Retry workspace cleanup", exact: true })
        .click(),
    ]);

    await expect(
      page.getByText("Workspace cleanup scheduled.", { exact: true }),
    ).toBeVisible();
    expect(retry.status()).toBe(202);
    expect(await retry.json()).toMatchObject({
      state: "armed",
      revision: 8,
      attempts: 0,
      errorCode: null,
    });
    await expect(
      page.getByRole("button", {
        name: "Retry workspace cleanup",
        exact: true,
      }),
    ).toHaveCount(0);
    const [ack] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith(`/api/runs/${failedId}/operational/acknowledge`),
      ),
      page
        .getByRole("button", {
          name: "Acknowledge operation failure",
          exact: true,
        })
        .click(),
    ]);

    await expect(
      page.getByText("Operation failure acknowledged.", { exact: true }),
    ).toBeVisible();
    expect(ack.status()).toBe(200);
    expect(await ack.json()).toMatchObject({ acknowledged: true, revision: 1 });
    await withE2EDb(async (pool) => {
      const result = await pool.query(
        "SELECT status, operational_terminal->>'effectiveOutcome' AS outcome FROM runs WHERE id=$1",
        [failedId],
      );

      expect(result.rows).toEqual([{ status: "Failed", outcome: "blocked" }]);
      const acknowledgement = await pool.query(
        "SELECT reason, revision FROM operational_run_acknowledgements WHERE run_id=$1",
        [failedId],
      );

      expect(acknowledgement.rows).toEqual([
        { reason: "operation_failure", revision: 1 },
      ]);
    });
  });
});

test("TB07: actual baseline Git probe failure is infrastructure before model execution, with safe details and retry guidance (EN/RU)", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const fixture = await seedManualTaskLaunchFixture();
  const hooks = path.join(fixture.root, "diagnostic-hooks");
  const privateContent = "private-fixture-source-token-not-for-ui";

  await mkdir(hooks);
  // Worktree creation completes before this hook corrupts its Git metadata.
  // The baseline's subsequent Git probes must fail before model dispatch.
  await writeFile(
    path.join(hooks, "post-checkout"),
    `#!/bin/sh
set -eu
if test -f .git; then
  cp .git .git.fixture-diagnostic-backup
  printf '%s\\n' '${privateContent}' > .git
fi
`,
    { mode: 0o755 },
  );
  await git(fixture.repo, "config", "core.hooksPath", hooks);
  let checkout: string | null = null;

  try {
    const created = await page.request.post(
      `/api/projects/${fixture.slug}/tasks`,
      {
        data: {
          title: "Inspect preparation infrastructure failure",
          prompt:
            "Inspect the tracked source; a failed workspace probe cannot assess this request.",
          flowId: fixture.flowId,
        },
      },
    );

    expect(created.status()).toBe(201);
    const task = (await created.json()) as { taskId: string };
    const launch = await page.request.post(
      `/api/projects/${fixture.slug}/agents/${encodeURIComponent(fixture.qualifierId)}/launch`,
      {
        headers: { Origin: new URL(baseURL!).origin },
        data: { taskId: task.taskId },
      },
    );

    expect(launch.status()).toBe(202);
    const { runId } = (await launch.json()) as { runId: string };

    checkout = await manualQualifierCheckoutPath(fixture.slug, runId);
    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (await pool.query("SELECT status FROM runs WHERE id=$1", [runId]))
                .rows[0].status,
          ),
        { timeout: 20_000 },
      )
      .toBe("Failed");
    const proof = await withE2EDb(
      async (pool) =>
        (
          await pool.query<{
            operational_terminal: {
              infrastructureFailure: {
                runId: string;
                assignmentId: string;
                assignmentEpoch: number;
                stage: string;
                probeOperation: string;
                causeChain: Array<{ code?: string | number }>;
              };
            };
            worktree_path: string | null;
            session_create_commands: number;
            prompt_commands: number;
            assessments: number;
          }>(
            "SELECT r.operational_terminal,w.worktree_path,(SELECT count(*)::int FROM execution_commands c WHERE c.run_id=r.id AND c.kind='session.create') AS session_create_commands,(SELECT count(*)::int FROM execution_commands c WHERE c.run_id=r.id AND c.kind='session.prompt') AS prompt_commands,(SELECT count(*)::int FROM task_qualifications q WHERE q.author_run_id=r.id) AS assessments FROM runs r LEFT JOIN workspaces w ON w.run_id=r.id WHERE r.id=$1 AND r.project_id=$2",
            [runId, fixture.projectId],
          )
        ).rows[0],
    );

    expect(proof).toBeDefined();
    await test.info().attach("pre-model-preparation-facts", {
      body: JSON.stringify(proof),
      contentType: "application/json",
    });
    expect(proof).toMatchObject({
      session_create_commands: 0,
      prompt_commands: 0,
      assessments: 0,
      operational_terminal: {
        infrastructureFailure: {
          runId,
          assignmentId: expect.any(String),
          assignmentEpoch: expect.any(Number),
          stage: "baseline",
          probeOperation: expect.stringMatching(/^git\./),
        },
      },
    });
    expect(
      proof.operational_terminal.infrastructureFailure.causeChain,
    ).toContainEqual(expect.objectContaining({ code: 128 }));
    for (const locale of ["en", "ru"] as const) {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      await page.goto(`/runs/${runId}`);
      const result = page
        .getByTestId("operational-result")
        .filter({ visible: true });

      await expect(result).toContainText(
        locale === "en"
          ? "Workspace preparation failed. This is an infrastructure failure, not a task assessment."
          : "Подготовка рабочего пространства завершилась ошибкой. Это сбой инфраструктуры, а не оценка задачи.",
      );
      await expect(result).toContainText(
        locale === "en"
          ? "resolve the reported problem before starting a new attempt"
          : "устраните указанную проблему перед новой попыткой",
      );
      await result
        .getByText(
          locale === "en" ? "Preparation details" : "Детали подготовки",
          { exact: true },
        )
        .click();
      const technical = result.locator("pre");

      await expect(technical).toContainText(runId);
      await expect(technical).toContainText('"stage": "baseline"');
      await expect(technical).toContainText('"probeOperation": "git.');
      await expect(technical).toContainText('"code": 128');
      await expect(technical).toContainText('"assignmentEpoch":');
      await expect(technical).not.toContainText(fixture.root);
      await expect(technical).not.toContainText(checkout);
      await expect(technical).not.toContainText(privateContent);
      await expect(technical).not.toContainText("stderr");
      await expect(result).not.toContainText(
        locale === "en"
          ? "Requester information needed"
          : "Нужны данные от автора",
      );
      await expect(
        page
          .getByRole("button", {
            name: locale === "en" ? "Run again…" : "Запустить повторно…",
            exact: true,
          })
          .filter({ visible: true }),
      ).toBeEnabled();
    }
  } finally {
    await git(fixture.repo, "config", "--unset", "core.hooksPath");
    // Restore only this hook's backed-up metadata. A terminal cleanup may
    // already have removed the fixture checkout; never remove unknown locks.
    if (checkout) {
      const backup = path.join(checkout, ".git.fixture-diagnostic-backup");

      if (existsSync(backup)) {
        await writeFile(path.join(checkout, ".git"), await readFile(backup));
        await unlink(backup);
      }
    }
  }
});

/** Catalog only: the test obtains assignment, baseline, session and prompt from the real launcher. */

test("E2E-CAP-05 save, inspect and restore a project persona in EN and RU", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const fixture = await seedManualTaskLaunchFixture();
  const agentId = await seedOperationalStopAgent(fixture);
  const route = `/projects/${fixture.slug}/agents/${encodeURIComponent(agentId)}?tab=definition`;
  const api = `/api/projects/${fixture.slug}/agents/${encodeURIComponent(agentId)}`;

  for (const locale of ["en", "ru"] as const) {
    const en = locale === "en";
    const localized = (english: string, russian: string): string =>
      en ? english : russian;

    await context.addCookies([
      { name: "NEXT_LOCALE", value: locale, url: baseURL! },
    ]);
    await page.goto(route);
    const edit = page.getByRole("button", {
      name: localized("Edit instance", "Редактировать инстанс"),
    });
    const compare = page.getByRole("button", {
      name: localized(
        "Compare with package prompt",
        "Сравнить с пакетным промптом",
      ),
    });

    await expect(compare).toHaveCount(0);
    await edit.focus();
    await page.keyboard.press("Enter");
    const text = page.getByRole("textbox", {
      name: localized("Agent prompt", "Промпт агента"),
    });
    const original = await text.inputValue();
    const changed = `Local persona ${locale} ${randomUUID()} ${E2E_HOLD_TURN_MARKER}`;

    await text.fill(changed);
    const save = page.getByRole("button", {
      name: localized("Save changes", "Сохранить изменения"),
    });

    await save.press("Enter");
    await expect(compare).toBeVisible();
    await compare.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(`+ ${changed}`, { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(compare).toBeVisible();
    if (en) {
      const response = await page.request.post(`${api}/launch`, {
        headers: { Origin: new URL(baseURL!).origin },
        data: {},
      });

      expect(response.status(), await response.text()).toBe(202);
      const { runId } = (await response.json()) as { runId: string };

      await expect
        .poll(
          () =>
            readStubSessionRecords(STUB_SESSIONS_DIR).find(
              (record) => record.request.runId === runId,
            )?.prompts[0]?.prompt,
          { timeout: 45000 },
        )
        .toContain(changed);
      const stopped = await page.request.post(`/api/runs/${runId}/stop`);

      expect(stopped.ok(), await stopped.text()).toBe(true);
    }
    await edit.press("Enter");
    await page
      .getByRole("button", {
        name: localized(
          "Restore package prompt",
          "Восстановить пакетный промпт",
        ),
      })
      .press("Enter");
    await expect(text).toHaveValue(original);
    await save.press("Enter");
    await expect(compare).toHaveCount(0);
    const persisted = await page.request.get(`${api}/definition`);

    expect(await persisted.json()).toMatchObject({
      prompt: original,
      instance: { promptOverridden: false, diverged: false },
    });
  }
});
