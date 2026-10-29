import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb, seedDefaultRunSession } from "./_seed/db";
import contract from "./_seed/operational-contract.json" with { type: "json" };

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
      await page.goto(`/runs/${successId}`);
      const result = page.locator('[data-testid="operational-result"]:visible');

      await expect(result).toBeVisible();
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
        page.locator('[data-testid="agent-run-review-cta"]:visible'),
      ).toBeVisible();
    });
  }

  test("IT-OPL-02 browser actions acknowledge a failure and rearm only workspace cleanup", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await page.goto(`/runs/${failedId}`);
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

    expect(retry.status()).toBe(202);
    expect(await retry.json()).toMatchObject({
      state: "armed",
      revision: 7,
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
