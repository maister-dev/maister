import type { Pool } from "pg";

import { randomUUID } from "node:crypto";

import { z } from "zod";
import { expect, test, type Page } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";
import { createE2EDbPool } from "./_seed/db";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";
import { contentDigest } from "@/lib/evaluations/digest";

test.use({ actionTimeout: 10000 });

async function enableKnowledgeProject(
  pool: Pool,
  slug: string,
): Promise<string> {
  const result = await pool.query(
    "UPDATE projects SET brain_enabled=true WHERE slug=$1 RETURNING id",
    [slug],
  );

  return z.object({ id: z.string() }).parse(result.rows[0]).id;
}

test("K07 opens authored rule and skill outcomes with their original Markdown", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { byKey } = loadFixtures();
  const projectSlug = byKey.m11a.projectSlug;
  const pool = createE2EDbPool(resolvePostgresDbUrl());

  try {
    const projectId = await enableKnowledgeProject(pool, projectSlug);

    for (const kind of ["rule", "skill"] as const) {
      const proposalId = randomUUID();
      const title = `Reviewed ${kind} ${proposalId.slice(0, 8)}`;
      const markdown = `Check the ${kind} against the original evidence.`;

      await pool.query(
        `INSERT INTO brain_proposals
          (id, project_id, kind, evidence_item_ids, draft, status, blast_radius, autonomy_decision, actor)
         VALUES ($1, $2, $3, '[]', $4::jsonb, 'pending', 'low', 'manual', $5::jsonb)`,
        [
          proposalId,
          projectId,
          kind,
          JSON.stringify({
            slug: `review-${proposalId}`,
            title,
            body: { markdown },
          }),
          JSON.stringify({ type: "system", id: "catalog-review-fixture" }),
        ],
      );
      const query = new URLSearchParams({
        projectId,
        kind: "brain",
        proposalKind: "brain",
        proposalId,
      });

      await page.goto(`/knowledge/reviews?${query}`);
      const selected = page.getByRole("region", { name: title });

      await selected.getByRole("button", { name: "Accept proposal" }).click();
      await selected
        .getByRole("link", { name: "Unpublished catalog draft" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(
          `/projects/${projectSlug}/brain/proposals/${proposalId}/draft$`,
        ),
      );
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByText(markdown, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save draft" }),
      ).toHaveCount(0);
    }
  } finally {
    await pool.end();
  }
});

test("E2E-CBU-01 correction retains an explicit missing-evidence declaration and preserves authored diagnostic-like text", async ({
  page,
  context,
}) => {
  const { byKey } = loadFixtures();
  const pool = createE2EDbPool(resolvePostgresDbUrl());
  const assertion = `Unverified maintenance hypothesis ${randomUUID()}`;
  const missing =
    "An independent configured health observation is unavailable.";
  const authored =
    "Legacy writer metadata does not establish submitting identity, observation time or confirmation.";

  try {
    const projectId = await enableKnowledgeProject(
      pool,
      byKey.m11a.projectSlug,
    );
    const created = await page.request.post("/api/knowledge/proposals", {
      data: {
        idempotencyKey: randomUUID(),
        content: {
          change: "add",
          owner: { kind: "project", projectId },
          title: assertion,
          kind: "assertion",
          assertion,
          basis: "inferred",
          evidence: [],
          missingEvidence: [{ state: "absent", reason: missing }],
          limitations: [authored],
        },
      },
    });

    expect(created.status(), await created.text()).toBe(201);
    const proposal = z.object({ id: z.string() }).parse(await created.json());
    const accepted = await page.request.post(
      `/api/knowledge/proposals/${proposal.id}/decision`,
      {
        data: {
          expectedRevision: 1,
          decision: "accept",
          reason:
            "Publish an explicitly unsupported hypothesis without confirming it.",
          idempotencyKey: randomUUID(),
        },
      },
    );

    expect(accepted.status(), await accepted.text()).toBe(200);
    const recordId = z
      .object({ published_record_id: z.string() })
      .parse(
        (
          await pool.query(
            "SELECT published_record_id FROM brain_proposals WHERE id=$1",
            [proposal.id],
          )
        ).rows[0],
      ).published_record_id;

    await page.goto(`/knowledge/${recordId}`);
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: new URL(page.url()).origin },
    ]);
    await page.reload();
    await expect(
      page.getByRole("main").getByText(authored, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Предложить исправление", exact: true })
      .click();
    await page
      .getByLabel("Утверждение", { exact: true })
      .fill(`${assertion}: corrected`);
    const retained = page.getByRole("checkbox", { name: new RegExp(missing) });

    await expect(retained).toBeChecked();
    await retained.uncheck();
    await page
      .getByRole("button", { name: "Отправить предложение", exact: true })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Проверьте обязательные поля и ссылки на доказательства.",
    );
    await retained.check();
    await page
      .getByRole("button", { name: "Отправить предложение", exact: true })
      .click();
    await expect(page).toHaveURL(/\/knowledge\/proposals\/[^/]+$/);
    const correctionId = page.url().split("/").at(-1)!;
    const retainedDraft = z
      .object({
        draft: z.object({
          missingEvidence: z.array(
            z.object({ state: z.string(), reason: z.string() }),
          ),
          limitations: z.array(z.string()),
        }),
      })
      .parse(
        (
          await pool.query("SELECT draft FROM brain_proposals WHERE id=$1", [
            correctionId,
          ])
        ).rows[0],
      ).draft;

    expect(retainedDraft).toMatchObject({
      missingEvidence: [{ state: "absent", reason: missing }],
      limitations: [authored],
    });
  } finally {
    await pool.end();
  }
});

test("E2E-CBU-01 missing retained evidence and legacy metadata diagnostics use the active language", async ({
  page,
  context,
}, testInfo) => {
  const { byKey } = loadFixtures();
  const pool = createE2EDbPool(resolvePostgresDbUrl());
  const recordId = randomUUID();
  const original = "Legacy retained maintenance observation";

  try {
    const projectId = await enableKnowledgeProject(
      pool,
      byKey.m11a.projectSlug,
    );

    await pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'state_fact','Legacy diagnostic inspection',$3,$4,0.99)",
      [recordId, projectId, original, randomUUID()],
    );
    await pool.query(
      "INSERT INTO brain_revision_evidence(record_id,revision,witness_id,relation,witness_snapshot) VALUES($1,1,$2,'supports','{\"restrictions\":[]}'::jsonb)",
      [recordId, randomUUID()],
    );
    await page.goto(`/knowledge/${recordId}`);
    for (const [locale, messages] of [
      [
        "en",
        [
          "Legacy writer metadata does not establish submitting identity, observation time or confirmation.",
          "Retained evidence is unavailable; no source metadata has been reconstructed.",
          "Some accepted evidence is unavailable; current support is incomplete.",
          "Historical source classification is unknown; retained ownership and current record policy still apply.",
        ],
      ],
      [
        "ru",
        [
          "Метаданные прежнего способа записи не устанавливают автора, время наблюдения или подтверждение.",
          "Сохранённое доказательство недоступно; метаданные источника не восстанавливались.",
          "Часть принятых доказательств недоступна; текущая доказательная база неполна.",
          "Классификация прежних источников неизвестна; сохранённое владение и текущая политика записи продолжают действовать.",
        ],
      ],
    ] as const) {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: new URL(page.url()).origin },
      ]);
      await page.reload();
      const surface = page.getByRole("main");

      for (const message of messages)
        await expect(surface.getByText(message, { exact: true })).toBeVisible();
      await expect(surface.getByText(original, { exact: true })).toBeVisible();
    }
    expect(await page.getByRole("main").innerText()).not.toContain(
      "Retained evidence is unavailable;",
    );
    await page.screenshot({
      path: testInfo.outputPath("knowledge-degraded-ru.png"),
      fullPage: true,
    });
  } finally {
    await pool.end();
  }
});

test("E2E-CBU-01 original delegated input is inspectable in English and Russian and withheld when capture becomes unavailable", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const { byKey } = loadFixtures();
  const runId = randomUUID();
  const pool = createE2EDbPool(resolvePostgresDbUrl());
  const parentId = randomUUID();
  const row = z
    .object({
      project_id: z.string(),
      task_id: z.string(),
      flow_id: z.string(),
      flow_version: z.string(),
    })
    .parse(
      (
        await pool.query(
          "SELECT project_id,task_id,flow_id,flow_version FROM runs WHERE id=$1",
          [byKey.m11a.runId],
        )
      ).rows[0],
    );
  const input = {
    schemaVersion: 1,
    sourceRunId: parentId,
    sourceGeneration: 1,
    sourceActor: {
      kind: "agent",
      id: byKey.platformAgents.helperAgentId,
      runId: parentId,
      attemptId: null,
    },
    sourceRestrictions: [
      { kind: "project_context", projectId: row.project_id },
    ],
    target: { kind: "flow", id: row.flow_id },
    title: `Retained private objective ${randomUUID()}`,
    prompt:
      "Inspect the original bounded diagnostic request without republishing it to a task card.",
  };
  const digest = contentDigest(input);

  try {
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version) VALUES($1,$2,'flow','Done','retained-input-browser')",
      [parentId, row.project_id],
    );
    await pool.query(
      `INSERT INTO runs (id,parent_run_id,knowledge_access,delegation_snapshot,project_id,task_id,flow_id,flow_version,run_kind,status)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,'flow','Done')`,
      [
        runId,
        parentId,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: input.sourceRestrictions,
        }),
        JSON.stringify({
          kind: "flow",
          carrierTaskId: row.task_id,
          flowId: row.flow_id,
          nativeInput: { ...input, inputDigest: digest },
        }),
        row.project_id,
        row.task_id,
        row.flow_id,
        row.flow_version,
      ],
    );
    await page.goto(`/runs/${runId}`);
    for (const [locale, title] of [
      ["en", "Original delegated input"],
      ["ru", "Исходное поручение"],
    ] as const) {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: new URL(page.url()).origin },
      ]);
      await page.goto(`/runs/${runId}?inspector=open`);
      const shell = page.getByTestId("run-shell").filter({ visible: true });

      const inspector = shell.getByTestId("run-shell-inspector");

      await expect(inspector).toBeVisible();
      const panel = inspector.getByTestId("native-input-inspection");

      await panel.getByText(title, { exact: true }).click();
      await expect(panel.getByText(input.title, { exact: true })).toBeVisible();
      await expect(
        panel.getByText(input.prompt, { exact: true }),
      ).toBeVisible();
      await expect(panel.getByRole("link")).toHaveAttribute(
        "href",
        `/runs/${parentId}`,
      );
      await expect(panel.locator("code")).toHaveText(digest);
    }
    await page.screenshot({
      caret: "initial",
      path: testInfo.outputPath("native-input-ru.png"),
      fullPage: true,
    });
    await pool.query(
      "UPDATE runs SET knowledge_access=jsonb_set(knowledge_access,'{state}','\"unknown\"') WHERE id=$1",
      [runId],
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Требуется доступ к источникам" }),
    ).toBeVisible();
    await expect(page.getByTestId("native-input-inspection")).toHaveCount(0);
    expect(await page.content()).not.toContain(input.prompt);
  } finally {
    await pool.query("DELETE FROM runs WHERE id IN ($1,$2)", [runId, parentId]);
    await pool.end();
  }
});

async function submitKnowledgeProposal(
  page: Page,
  buttonName: string,
): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/knowledge/proposals" &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const receipt = await created;

  expect(receipt.status(), await receipt.text()).toBe(201);
  const { id } = z
    .object({ id: z.string().uuid() })
    .parse(await receipt.json());
  const proposalUrl = new URL(`/knowledge/proposals/${id}`, page.url()).href;

  await expect(page).toHaveURL(proposalUrl, { timeout: 30_000 });

  return proposalUrl;
}

// This is the native browser/session path. Live installed-package qualification has a separate lane.
test("E2E-CBU-01 an administrator explicitly enables company knowledge and reviews a captured assertion without implicitly confirming it", async ({
  page,
  context,
  browser,
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
  const ownerSelection = surface.getByLabel("Ownership", { exact: true });

  await ownerSelection.selectOption({ label: "Company" });
  await expect(ownerSelection).toHaveValue(/^c:/);
  const originalProposalUrl = await submitKnowledgeProposal(
    page,
    "Submit proposal",
  );

  await expect(
    surface.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  // Model two independent reviewers so each has its own HTTP/1.1 connection pool.
  const competingReview = await browser.newPage({
    storageState: await context.storageState(),
  });

  try {
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
    await expect(page).toHaveURL(originalProposalUrl);
    await page.getByRole("link", { name: "Open reviews in Inbox" }).click();
    await expect(page).toHaveURL(/\/knowledge\/reviews\?/);
    const reviewUrl = page.url();

    await competingReview.goto(reviewUrl);
    await page
      .getByLabel("Reason (required)", { exact: true })
      .fill("Inspected the exact captured runbook version");
    const competingSurface = competingReview.getByRole("main");

    await competingSurface
      .getByLabel("Reason (required)", { exact: true })
      .fill("A stale competing decision must preserve the accepted result.");
    await page
      .getByRole("button", { name: "Accept proposal", exact: true })
      .click();
    await expect(
      surface.getByRole("link", { name: "Published revision", exact: true }),
    ).toBeVisible();

    await competingSurface
      .getByRole("button", { name: "Reject proposal", exact: true })
      .click();
    await expect(competingSurface.getByRole("alert")).toContainText(
      "Changed during review",
    );
    await competingSurface
      .getByRole("button", { name: "Reload reviewed version" })
      .click();
    await expect(
      competingSurface.getByRole("link", {
        name: "Published revision",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await competingReview.close();
  }
  await page
    .getByRole("link", { name: "Published revision", exact: true })
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
  await submitKnowledgeProposal(
    page,
    "Отправить предложение",
  );

  await expect(
    surface.getByText("Ожидает рассмотрения", { exact: true }),
  ).toBeVisible();
  await surface
    .getByRole("link", { name: "Открыть предложения во входящих", exact: true })
    .click();
  await surface
    .getByLabel("Причина (обязательно)", { exact: true })
    .fill(
      "Исправление сохраняет исходный источник и требует отдельного подтверждения.",
    );
  await surface
    .getByRole("button", { name: "Принять предложение", exact: true })
    .click();
  await surface
    .getByRole("link", { name: "Опубликованная версия", exact: true })
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
  const revokedPage = await context.newPage();
  const revokedSurface = revokedPage.getByRole("main");

  await revokedPage.goto(recordUrl);
  await expect(
    revokedSurface.getByRole("heading", {
      name: "Знание недоступно",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    revokedSurface.getByText(corrected, { exact: true }),
  ).toBeHidden();
  await revokedPage.goto(`/knowledge?q=${encodeURIComponent(title)}`);
  await expect(
    revokedSurface.getByText("Нет доступных знаний по этим фильтрам.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    revokedSurface.getByRole("link", { name: title, exact: true }),
  ).toBeHidden();
  await revokedPage.goto(`/knowledge/witnesses/${randomUUID()}`);
  await expect(
    revokedSurface.getByRole("heading", {
      name: "Знание недоступно",
      exact: true,
    }),
  ).toBeVisible();
  await revokedPage.close();
});

test("K11 issues an account token with independently selected review and vault scopes", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "New token", exact: true }).click();
  const dialog = page.getByRole("dialog");

  await dialog
    .getByLabel("Name", { exact: true })
    .fill(`Knowledge review ${randomUUID()}`);
  await dialog
    .getByRole("checkbox", {
      name: "Settle authorized knowledge and vault reviews",
    })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Read accessible agent memory" })
    .check();
  const receipt = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/account/tokens") &&
      response.request().method() === "POST",
  );

  await dialog
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const issued = await receipt;

  expect(issued.status()).toBe(201);
  const { scopes } = await issued.json();

  expect(scopes).toEqual(
    expect.arrayContaining(["agent_memory:read", "decisions:review"]),
  );
  expect(scopes).not.toContain("*");
});

// Browser inspection uses retained fixtures; installable-package/live ACP acceptance remains a separate required gate.
test("E2E-CBU-01 findings preserve exact evidence links and retained revisions in English and Russian", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const { byKey } = loadFixtures();
  const projectSlug = byKey.m11a.projectSlug;
  const pool = createE2EDbPool(resolvePostgresDbUrl());
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
    const witnessPage = await context.newPage();

    await witnessPage.goto(`/knowledge/witnesses/${witness.id}`);
    await expect(
      witnessPage.getByRole("main").getByText(assertion, { exact: true }),
    ).toBeVisible();
    await witnessPage.close();
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
