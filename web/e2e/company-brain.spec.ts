import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { z } from "zod";
import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";

test.use({ actionTimeout: 10000 });

// This is the native browser/session path. Live installed-package qualification has a separate lane.
test("E2E-CBU-01 an administrator explicitly enables company knowledge and reviews a captured assertion without implicitly confirming it", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const { users } = loadFixtures();
  const surface = page.getByRole("main");
  const title = `Company runbook ${randomUUID()}`;
  const source =
    "Use the configured independent health observation after an allowed restart.";

  await page.goto("/settings/company-grants");
  await expect(
    surface.getByRole("heading", { name: "Company access" }),
  ).toBeVisible();
  await surface
    .getByRole("link", { name: "Grant access", exact: true })
    .click();
  await page
    .getByLabel("Principal", { exact: true })
    .selectOption(`user:${users.admin.id}`);
  for (const action of [
    "Read knowledge",
    "Propose knowledge",
    "Review knowledge",
    "Confirm knowledge",
  ])
    await surface.getByLabel(action, { exact: true }).check();
  await surface
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/company-grants$/);
  await page.goto("/knowledge");
  await expect(
    surface.getByRole("heading", { name: "Company Brain", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Propose knowledge", exact: true })
    .click();
  await surface.getByLabel("Title", { exact: true }).fill(title);
  await surface.getByLabel("Assertion", { exact: true }).fill(source);
  await page
    .getByLabel("Source title", { exact: true })
    .fill("Configured maintenance runbook");
  await surface
    .getByLabel("Captured source text", { exact: true })
    .fill(source);
  await page
    .getByRole("button", { name: "Submit proposal", exact: true })
    .click();
  await expect(page).toHaveURL(/\/knowledge\/proposals\/[^/]+$/);
  await expect(
    surface.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const originalProposalUrl = page.url();
  const competingReview = await context.newPage();

  await competingReview.goto(originalProposalUrl);
  await expect(
    competingReview
      .getByRole("main")
      .getByText("Pending review", { exact: true }),
  ).toBeVisible();
  await page.goto("/knowledge/proposals");
  await surface.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(originalProposalUrl);

  await expect(
    surface.getByText("Pending review", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Inspect evidence", exact: true })
    .click();
  await expect(surface.getByText(source, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/knowledge\/witnesses\/[^/]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/knowledge\/proposals\/(?!new$)[^/]+$/);
  await page
    .getByLabel("Decision reason", { exact: true })
    .fill("Inspected the exact captured runbook version");
  await page
    .getByRole("button", { name: "Accept proposal", exact: true })
    .click();
  await expect(
    surface.getByRole("link", { name: "Published record", exact: true }),
  ).toBeVisible();
  const competingSurface = competingReview.getByRole("main");

  await competingSurface
    .getByLabel("Decision reason", { exact: true })
    .fill("A stale competing decision must preserve the accepted result.");
  await competingSurface
    .getByRole("button", { name: "Reject proposal", exact: true })
    .click();
  await expect(competingSurface.getByRole("alert")).toHaveText(
    "The revision or delivery changed. Reload and review the current record before retrying.",
  );
  await competingReview.reload();
  await expect(
    competingSurface.getByRole("link", {
      name: "Published record",
      exact: true,
    }),
  ).toBeVisible();
  await competingReview.close();
  await page
    .getByRole("link", { name: "Published record", exact: true })
    .click();
  await expect(surface.getByText("Unconfirmed", { exact: true })).toBeVisible();
  await surface
    .getByRole("link", { name: "Open current record", exact: true })
    .click();
  await surface.getByLabel("Use this supporting witness").check();
  await page
    .getByLabel("Confirmation reason", { exact: true })
    .fill("Confirm against the original available source witness");
  await page
    .getByRole("button", { name: "Confirm assertion", exact: true })
    .click();
  await expect(surface.getByText("Confirmed", { exact: true })).toBeVisible();
  const recordUrl = page.url();

  await page.goto(`/knowledge?q=${encodeURIComponent(title)}`);
  await expect(
    surface.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    surface.getByRole("searchbox", { name: "Search knowledge", exact: true }),
  ).toHaveValue(title);
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: new URL(recordUrl).origin },
  ]);
  await page.goto(recordUrl);
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await surface
    .getByRole("link", { name: "Предложить исправление", exact: true })
    .click();
  const corrected = `${source} Preserve its original version witness.`;

  await surface.getByLabel("Утверждение", { exact: true }).fill(corrected);
  await surface
    .getByRole("button", { name: "Отправить предложение", exact: true })
    .click();
  await expect(
    surface.getByText("Ожидает рассмотрения", { exact: true }),
  ).toBeVisible();
  await surface
    .getByLabel("Обоснование решения", { exact: true })
    .fill(
      "Исправление сохраняет исходный источник и требует отдельного подтверждения.",
    );
  await surface
    .getByRole("button", { name: "Принять предложение", exact: true })
    .click();
  await surface
    .getByRole("link", { name: "Опубликованная запись", exact: true })
    .click();
  await surface
    .getByRole("link", { name: "Открыть текущую запись", exact: true })
    .click();
  await expect(page).toHaveURL(recordUrl);
  await expect(
    surface.getByText("Не подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(surface.getByText(corrected, { exact: true })).toBeVisible();
  await surface
    .getByRole("heading", { name: title, exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("company-knowledge-ru.png"),
  });
  await page.goto(originalProposalUrl);
  await surface
    .getByRole("link", { name: "Опубликованная запись", exact: true })
    .click();
  await expect(page).toHaveURL(`${recordUrl}?revision=1`);
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(
    surface.getByRole("link", { name: "Открыть текущую запись", exact: true }),
  ).toBeVisible();
  await page.goto(recordUrl);
  await surface.getByLabel("Использовать этот подтверждающий источник").check();
  await surface
    .getByLabel("Обоснование подтверждения", { exact: true })
    .fill("Проверен исходный доступный свидетель содержимого.");
  await surface
    .getByRole("button", { name: "Подтвердить утверждение", exact: true })
    .click();
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await surface
    .getByLabel("Обоснование подтверждения", { exact: true })
    .fill("Требуется повторная независимая проверка.");
  await surface
    .getByRole("button", { name: "Отозвать подтверждение", exact: true })
    .click();
  const confirmationDialog = page.getByRole("dialog");

  await confirmationDialog
    .getByRole("button", { name: "Отозвать подтверждение", exact: true })
    .click();
  await expect(confirmationDialog).toBeHidden();
  await expect(
    surface.getByText("Подтверждение отозвано", { exact: true }),
  ).toBeVisible();
  await page.goto("/settings/company-grants");
  const readGrant = surface
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: /Читать знания/ }) });

  await readGrant
    .getByRole("button", { name: "Отозвать доступ", exact: true })
    .click();
  const grantDialog = page.getByRole("dialog");

  await grantDialog
    .getByLabel("Причина отзыва", { exact: true })
    .fill("Доступ к знаниям отозван для проверки действующих прав.");
  await grantDialog
    .getByRole("button", { name: "Отозвать доступ", exact: true })
    .click();
  await expect(grantDialog).toBeHidden();
  await page.goto(recordUrl);
  await expect(
    surface.getByRole("heading", { name: "Знание недоступно", exact: true }),
  ).toBeVisible();
  await expect(surface.getByText(corrected, { exact: true })).toBeHidden();
  await page.goto(`/knowledge?q=${encodeURIComponent(title)}`);
  await expect(
    surface.getByText("Нет доступных знаний по этим фильтрам.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    surface.getByRole("link", { name: title, exact: true }),
  ).toBeHidden();
  await page.goto(`/knowledge/witnesses/${randomUUID()}`);
  await expect(
    surface.getByRole("heading", { name: "Знание недоступно", exact: true }),
  ).toBeVisible();
});

// Browser inspection uses retained fixtures; installable-package/live ACP acceptance remains a separate required gate.
test("E2E-CBU-01 findings preserve exact evidence links and retained revisions in English and Russian", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const { byKey } = loadFixtures();
  const projectSlug = byKey.m11a.projectSlug;
  const pool = new Pool({ connectionString: resolvePostgresDbUrl() });
  const runId = randomUUID();
  const childRunId = randomUUID();
  const assertion = `Bounded health observation ${randomUUID()}`;
  const witnessSchema = z.object({
    id: z.string(),
    sha256: z.string(),
    sourceVersion: z.string().nullable(),
  });

  try {
    const project = (
      await pool.query<{ id: string }>(
        "SELECT id FROM projects WHERE slug=$1",
        [projectSlug],
      )
    ).rows[0];

    expect(project).toBeDefined();
    const projectId = project!.id;

    await pool.query("UPDATE projects SET brain_enabled=true WHERE id=$1", [
      projectId,
    ]);
    const capture = await page.request.post("/api/knowledge/sources", {
      data: {
        owner: { kind: "project", projectId },
        title: "Retained health source",
        content: assertion,
        idempotencyKey: `findings-browser:${runId}`,
      },
    });

    const capturedBody = await capture.text();

    expect(capture.status(), capturedBody).toBe(201);
    const witness = witnessSchema.parse(JSON.parse(capturedBody));
    const contract = {
      kind: "flow_export",
      nativeContract: "evidence_findings_v1",
      schemaRef: "browser-inspection@aaaaaaaaaaaa:findings.v1",
      schemaVersion: 1,
      sha256: "b".repeat(64),
      required: true,
      producerNodeIds: ["coordinator"],
      schema: { schemaVersion: 1, fields: [] },
      flowRevisionId: "retained-browser-fixture",
    };
    const knowledgeAccess = {
      schemaVersion: 1,
      state: "complete",
      generation: 1,
      restrictions: [{ kind: "project", projectId }],
    };

    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,result_contract,knowledge_access) VALUES($1,$2,'flow','Done','retained-browser-fixture',$3::jsonb,$4::jsonb),($5,$2,'flow','Done','retained-browser-fixture',$3::jsonb,$4::jsonb)",
      [
        runId,
        projectId,
        JSON.stringify(contract),
        JSON.stringify(knowledgeAccess),
        childRunId,
      ],
    );
    await pool.query("UPDATE runs SET parent_run_id=$2 WHERE id=$1", [
      childRunId,
      runId,
    ]);
    const baseFinding = {
      id: "health",
      assertion,
      basis: "observed",
      supporting: [{ kind: "witness", id: witness.id, sha256: witness.sha256 }],
      contradicting: [],
      missingEvidence: [
        {
          state: "unknown",
          reason: "Current applicability requires a new health check.",
        },
      ],
      limitations: ["The source records one observation."],
      openQuestions: ["Has the component changed?"],
      sourceFindings: [],
    };
    const child = {
      schemaVersion: 1,
      findings: [baseFinding],
      knowledgeProposals: [],
      selection: [],
    };
    const parent = {
      ...child,
      findings: [
        {
          ...baseFinding,
          sourceFindings: [
            { childRunId, resultRevision: 1, findingId: "health" },
          ],
        },
      ],
      selection: [
        {
          childRunId,
          resultRevision: 1,
          findingId: "health",
          disposition: "retained",
          outputFindingIds: ["health"],
        },
      ],
    };
    const firstId = randomUUID();
    const nextId = randomUUID();

    await pool.query(
      "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_sha256,schema_version,producer_kind,producer_ref,value,value_bytes,engine_version,first_collected_at) VALUES($1,$2,1,'valid',$3,$4,1,'flow_node','coordinator',$5::jsonb,$6,'retained-browser-fixture',now())",
      [
        randomUUID(),
        childRunId,
        contract.schemaRef,
        contract.sha256,
        JSON.stringify(child),
        Buffer.byteLength(JSON.stringify(child)),
      ],
    );
    await pool.query(
      "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_sha256,schema_version,producer_kind,producer_ref,value,value_bytes,engine_version) VALUES($1,$2,1,'superseded',$3,$4,1,'flow_node','coordinator',$5::jsonb,$6,'retained-browser-fixture'),($7,$2,2,'valid',$3,$4,1,'flow_node','coordinator',$5::jsonb,$6,'retained-browser-fixture')",
      [
        firstId,
        runId,
        contract.schemaRef,
        contract.sha256,
        JSON.stringify(parent),
        Buffer.byteLength(JSON.stringify(parent)),
        nextId,
      ],
    );
    await pool.query(
      "UPDATE run_results SET superseded_by_id=$2,superseded_at=now() WHERE id=$1",
      [firstId, nextId],
    );
    const url = `/knowledge/results/${runId}/1`;

    await page.goto(url);
    const main = page.getByRole("main");
    const findings = main.getByTestId("native-findings");

    await expect(
      main.getByRole("heading", {
        name: "Retained result revision",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      findings.getByRole("heading", { name: assertion, exact: true }),
    ).toBeVisible();
    await expect(
      findings.getByText("Current applicability requires a new health check.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      findings.getByRole("link", {
        name: `witness:${witness.id}`,
        exact: true,
      }),
    ).toHaveAttribute("href", `/knowledge/witnesses/${witness.id}`);
    await findings
      .getByRole("link", { name: `witness:${witness.id}`, exact: true })
      .click();
    await expect(main.getByText(assertion, { exact: true })).toBeVisible();
    await page.goto(url);
    await page
      .getByTestId("native-findings")
      .getByRole("link", { name: `${childRunId}@1 · health`, exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/knowledge/results/${childRunId}/1#finding-health$`),
    );
    await expect(
      page
        .getByTestId("native-findings")
        .getByRole("heading", { name: assertion, exact: true }),
    ).toBeVisible();
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: new URL(page.url()).origin },
    ]);
    await page.goto(url);
    await expect(
      main.getByRole("heading", {
        name: "Сохранённая ревизия результата",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", {
        name: "Выводы со ссылками на доказательства",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", {
        name: "Недостающие доказательства",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      caret: "initial",
      path: testInfo.outputPath("native-findings-ru.png"),
    });
    expect(
      (
        await pool.query(
          "SELECT first_collected_at FROM run_results WHERE run_id=$1 ORDER BY revision",
          [runId],
        )
      ).rows,
    ).toEqual([{ first_collected_at: null }, { first_collected_at: null }]);
    await pool.query("UPDATE projects SET brain_enabled=false WHERE id=$1", [
      projectId,
    ]);
    await page.reload();
    await expect(
      main.getByRole("heading", { name: "Знание недоступно", exact: true }),
    ).toBeVisible();
    await expect(main.getByText(assertion, { exact: true })).toBeHidden();
  } finally {
    await pool.query("DELETE FROM runs WHERE id=ANY($1::text[])", [
      [runId, childRunId],
    ]);
    await pool.end();
  }
});
