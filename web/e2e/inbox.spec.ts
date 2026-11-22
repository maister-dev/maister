import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { generateToken } from "../lib/tokens/secret";

import { loadFixtures } from "./_seed/fixtures";
import { withE2EDb } from "./_seed/db";

// Inbox card redesign: the full-bleed, project-grouped /inbox surface rendering
// the unified 3-tier HitlCard, plus the canonical `decisions` badge fan-out
// (ADR-169). Relies on the shared seed having at least one pending
// cross-project HITL (the board / m17 fixtures seed NeedsInput runs), so
// `decisions` > 0.

// The lazy expanded tier is asserted against a mocked inbox-context response so
// the gates/message/progress/diff render is deterministic regardless of the
// shared seed's per-run state.
const MOCK_INBOX_CONTEXT = {
  lastAgentMessage: {
    text: "Need a decision on the migration.",
    at: "2026-06-01T10:00:00.000Z",
  },
  gates: [
    {
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
    },
  ],
  diff: { files: 2, additions: 10, deletions: 3 },
  progress: { done: 1, total: 4 },
};

test("AV-04 applies a webhook run's pending note through Inbox while the amber count stays fixed", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const runId = randomUUID();
  const projectId = randomUUID();
  const slug = `inbox-vault-${projectId.slice(0, 8)}`;
  const agentId = `fixture:${slug}`;
  const token = generateToken();
  const reviewerId = randomUUID();
  const reviewerEmail = `vault-${reviewerId}@example.test`;
  const { adminEmail, adminPassword } = loadFixtures();

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1) ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key,brain_enabled) VALUES ($1,$2,'Inbox vault fixture',$3,$4,true)",
      [
        projectId,
        slug,
        `/tmp/${slug}`,
        `VR${projectId.slice(0, 7).toUpperCase()}`,
      ],
    );
    // The reviewer's rail counts only this project while other workers create
    // and resolve unrelated decisions in parallel.
    await pool.query(
      `INSERT INTO users(id,email,password_hash,role,account_status,must_change_password)
       SELECT $1,$2,password_hash,'member','active',false FROM users WHERE email=$3`,
      [reviewerId, reviewerEmail, adminEmail],
    );
    await pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [randomUUID(), projectId, reviewerId],
    );
    await pool.query(
      `INSERT INTO tasks(id,project_id,number,title,prompt,status,triage_status,triage_flag_origin)
       VALUES ($1,$2,1,'Review pending request','Inbox fixture','Backlog','flagged','explicit')`,
      [randomUUID(), projectId],
    );
    await pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture','v1','git','Webhook Vault','Fixture','none','session','[]','read_only','/unused/webhook-vault.md')`,
      [agentId],
    );
    await pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled) VALUES ($1,$2,$3,true)",
      [randomUUID(), projectId, agentId],
    );
    await pool.query(
      `INSERT INTO runs(id,project_id,run_kind,agent_id,status,flow_version,agent_workspace,trigger_source)
      VALUES ($1,$2,'agent',$3,'Pending','test','none','webhook')`,
      [runId, projectId, agentId],
    );
    await pool.query(
      `INSERT INTO project_tokens(id,project_id,bound_run_id,origin_kind,name,token_kind,agent_id,prefix,token_hash,scopes,expires_at)
      VALUES ($1,$2,$3,'agent_run',$4,'agent',$5,$6,$7,'["agent_memory:read","agent_memory:write"]',now()+interval '1 hour')`,
      [
        randomUUID(),
        projectId,
        runId,
        `agent-run:${runId}`,
        agentId,
        token.prefix,
        token.hash,
      ],
    );
  });

  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(reviewerEmail);
  await page.locator('input[name="password"]').fill(adminPassword);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  await page.goto(
    `/inbox?${new URLSearchParams({ kind: "vault", projectId, agentId })}`,
  );
  const rail = page.locator('nav[aria-label="Sections"]');
  const decisions = rail.getByTestId("inbox-nav-badge");
  const reviews = rail.getByTestId("reviews-nav-badge");

  await expect(decisions).toHaveText("1");
  await expect(reviews).toHaveCount(0);
  const group = page.getByRole("region", { name: "Knowledge & memory" });
  const pathname = "/memories/index.md";
  const pending = await page.request.post("/api/v1/ext/agent/memory/commands", {
    headers: { authorization: `Bearer ${token.secret}` },
    data: {
      command: "create",
      path: pathname,
      file_text: "Permanent after review",
      ifHash: null,
      ifRevisionId: null,
      requestKey: "webhook-inbox-memory",
    },
  });

  expect(pending.status()).toBe(202);
  const receipt = (await pending.json()) as { proposalId: string };
  const authorized = await page.request.get(
    `/api/inbox/reviews?${new URLSearchParams({ kind: "vault", projectId, agentId })}`,
  );

  expect(await authorized.json()).toMatchObject({
    items: [{ id: receipt.proposalId }],
  });

  await expect(reviews).toHaveText("1", {
    timeout: 45_000,
  });
  await expect(decisions).toHaveText("1");
  const preview = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/inbox/reviews/vault/${receipt.proposalId}`),
    { timeout: 30_000 },
  );

  await group.getByRole("button", { name: "View proposal" }).click();
  expect((await preview).ok()).toBe(true);
  const dialog = page.getByRole("dialog", { name: pathname });

  await expect(
    dialog.getByText("+Permanent after review", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close proposal" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const direct = `/api/inbox/reviews/vault/${receipt.proposalId}`;
  const workspace = `/knowledge/reviews?${new URLSearchParams({ kind: "vault", projectId })}`;

  await page.goto(workspace);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  const rowLink = page.getByRole("link", {
    name: "View proposal",
    exact: true,
  });

  await rowLink.focus();
  await page.keyboard.press("Enter");
  const selected = page.getByRole("region", { name: pathname });

  await expect(selected.getByRole("heading", { name: pathname })).toBeFocused();
  await selected.getByRole("button", { name: "Close proposal" }).click();
  await expect(rowLink).toBeFocused();

  await page.route(`**${direct}`, (route) =>
    route.fulfill({ status: 503, json: { code: "CRASH" } }),
  );
  await page.goto(
    `/knowledge/reviews?${new URLSearchParams({ kind: "vault", projectId, proposalKind: "vault", proposalId: receipt.proposalId })}`,
  );
  await expect(
    page.getByText("The proposal could not be loaded."),
  ).toBeVisible();
  await page.unroute(`**${direct}`);
  await page.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    selected.getByText("+Permanent after review", { exact: false }),
  ).toBeVisible();
  await expect(
    selected.getByText("Apply the proposed memory changes.", { exact: true }),
  ).toBeVisible();
  const settled = page.waitForResponse(`**${direct}/decision`, {
    timeout: 30_000,
  });

  await selected.getByRole("button", { name: "Accept proposal" }).focus();
  await page.keyboard.press("Enter");
  const result = await settled;

  expect(result.ok()).toBe(true);
  expect(await result.json()).toMatchObject({
    receiptId: expect.any(String),
    domainState: "accepted",
    outcome: { type: "applied_vault_operation" },
  });
  await expect(
    selected.getByText("Applied vault operation", { exact: true }),
  ).toBeVisible();
  await expect(reviews).toHaveCount(0, { timeout: 45_000 });
  await expect(decisions).toHaveText("1");
  await withE2EDb(async (pool) => {
    const evidence = await pool.query(
      `SELECT p.state, r.author->>'runId' AS author_run_id, payload.content
      FROM agent_memory_proposals p JOIN agent_memory_revisions r ON r.operation_id=p.applied_operation_id
      JOIN agent_memory_revision_payloads payload ON payload.revision_id=r.id WHERE p.id=$1`,
      [receipt.proposalId],
    );

    expect(evidence.rows).toEqual([
      {
        state: "accepted",
        author_run_id: runId,
        content: "Permanent after review",
      },
    ]);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .context()
    .addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: new URL(page.url()).origin },
    ]);
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.reload();
  const applied = page.getByRole("link", {
    name: "Применённое изменение памяти",
    exact: true,
  });

  await expect(applied).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
  await applied.click();
  await expect(page).toHaveURL(/\/knowledge\/memory\?.*memoryRevision=/);
  const vault = page.getByRole("region", { name: "Хранилище памяти" });

  await expect(
    vault.getByText("Permanent after review", { exact: true }),
  ).toBeVisible();
  await expect(
    vault.getByRole("button", { name: "Изменить заметку" }),
  ).toHaveCount(0);
  const exact = new URL(page.url()).searchParams;
  const legacy = new URLSearchParams({
    tab: "memory",
    memoryNoteId: exact.get("memoryNoteId")!,
    memoryRevision: exact.get("memoryRevision")!,
    memoryView: "source",
  });

  await page.goto(
    `/projects/${slug}/agents/${encodeURIComponent(agentId)}?${legacy}`,
  );
  await expect(
    vault.getByText("Permanent after review", { exact: true }),
  ).toBeVisible();
  const current = new URLSearchParams({
    locationId: exact.get("locationId")!,
    memoryNoteId: exact.get("memoryNoteId")!,
  });

  await page.goto(`/knowledge/memory?${current}`);
  await vault
    .getByRole("button", { name: "Предложить на основе заметки" })
    .click();
  await vault.getByLabel("Назначение и тип предложения").selectOption({
    label: "Inbox vault fixture · Изменение проекта",
  });
  const title = "Project knowledge from the reviewed note";

  await vault.getByLabel("Заголовок предложения").fill(title);
  await vault.getByRole("button", { name: "Отправить на проверку" }).click();
  await expect(
    vault.getByText("Отправлено на проверку.", { exact: true }),
  ).toBeVisible();
  await vault.getByRole("link", { name: "Открыть предложение" }).click();
  await expect(page.getByRole("region", { name: title })).toBeVisible();
  await expect(page).toHaveURL(
    /\/knowledge\/reviews\?proposalKind=brain&proposalId=/,
  );

  const history = new URLSearchParams({
    kind: "vault",
    projectId,
    proposalKind: "vault",
    proposalId: receipt.proposalId,
    view: "history",
  });
  const observer = await page.context().newPage();

  try {
    const watch = observer.waitForRequest((request) => {
      const url = new URL(request.url());

      return (
        url.pathname === "/api/attention/stream" &&
        url.searchParams.get("reviewId") === receipt.proposalId
      );
    });

    await observer.goto(`/knowledge/reviews?${history}`);
    await expect(
      observer.getByText("+Permanent after review", { exact: false }),
    ).toBeVisible();
    expect((await (await watch).response())?.ok()).toBe(true);
    const revisionId = exact.get("memoryRevision");

    expect(revisionId).toBeTruthy();
    const redacted = await page.request.post(
      `/api/agent-memory/revisions/${revisionId}/redact`,
      {
        data: {
          reason: "Withdraw the reviewed source from the open history view",
          requestKey: `inbox-review-redact-${projectId}`,
        },
      },
    );

    expect(redacted.ok()).toBe(true);
    await expect(
      observer.getByText("+Permanent after review", { exact: false }),
    ).toHaveCount(0, { timeout: 45_000 });
    await expect(observer.getByRole("alert")).toContainText(
      "Предложение недоступно.",
    );
    await expect(
      observer.getByRole("link", {
        name: "Применённое изменение памяти",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await observer.close();
  }
});

test.describe("Inbox card redesign", () => {
  test("shows an active agent clarification after its source agent has ended", async ({
    page,
  }) => {
    const humanAsk = loadFixtures().byKey.humanAsk;

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ visible: true })
      .filter({ has: page.getByText(humanAsk.question, { exact: true }) });

    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-kind", "agent_question");
    await expect(
      card.getByText("Agent question", { exact: true }),
    ).toBeVisible();

    await card.locator("button[aria-expanded]").first().click();
    const response = card.getByTestId("agent-question-response");

    await expect(response).toBeVisible();
    await expect(
      response.getByRole("button", { name: "Answer clarification" }),
    ).toBeVisible();
  });

  test("the Inbox nav reaches /inbox and renders unified HITL cards", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator('nav[aria-label="Sections"] a[href="/inbox"]').click();

    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(
      page.getByTestId("hitl-card").filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test("a Flow review card routes to the code Review Workspace without an inline decision", async ({
    page,
  }) => {
    // This parked gate has a real Git worktree and stays open after the
    // diff-scope scenario records its dirty-worktree decision.
    const reviewRunId = loadFixtures().byKey.reviewDiffScopes.runId;

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ visible: true })
      .filter({
        has: page.locator(
          `a[href="/runs/${reviewRunId}?wb=review&scope=review"]`,
        ),
      });

    await expect(card).toHaveCount(1);
    await expect(card.getByRole("link", { name: "Review code" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Respond" })).toHaveCount(0);

    await card.getByRole("link", { name: "Review code" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/runs/${reviewRunId}\\?wb=review&scope=review`),
    );
    await expect(
      page.getByRole("region", { name: "Review workspace" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("expanding a card lazily fetches and renders its decision context", async ({
    page,
  }) => {
    await page.route("**/api/runs/*/inbox-context", (route) =>
      route.fulfill({ json: MOCK_INBOX_CONTEXT }),
    );

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ visible: true })
      .first();

    await expect(card).toBeVisible();
    // The collapsed card carries a View-run link to the run page.
    await expect(card.locator('a[href^="/runs/"]').first()).toBeVisible();

    // The header toggle drives the collapsed → expanded disclosure and the
    // lazy inbox-context fetch.
    const toggle = card.locator("button[aria-expanded]").first();

    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const contextResponse = page.waitForResponse("**/api/runs/*/inbox-context");

    await toggle.click();
    await contextResponse;

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The fetched context renders: a gate chip, the last agent message, the
    // done/total progress fraction, and the changes summary.
    await expect(card.getByText("lint")).toBeVisible();
    await expect(
      card.getByText("Need a decision on the migration."),
    ).toBeVisible();
    await expect(card.getByText("1 / 4")).toBeVisible();
    await expect(card.getByText(/2 files/)).toBeVisible();
  });

  test("a failed context load surfaces an error with a working retry", async ({
    page,
  }) => {
    let calls = 0;

    await page.route("**/api/runs/*/inbox-context", async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({
          status: 500,
          json: { code: "CRASH", message: "boom" },
        });
      } else {
        await route.fulfill({ json: MOCK_INBOX_CONTEXT });
      }
    });

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ visible: true })
      .first();
    const toggle = card.locator("button[aria-expanded]").first();

    await toggle.click();

    // The failed fetch shows the alert + retry control, not the context.
    const alert = card.getByRole("alert");

    await expect(alert).toBeVisible();
    await expect(card.getByText("lint")).toHaveCount(0);

    // Retry succeeds (second response is 200) and the context renders.
    await alert.getByRole("button").click();
    await expect(card.getByText("lint")).toBeVisible();
  });

  test("the rail badge and the portfolio summary show the same canonical count", async ({
    page,
  }) => {
    // The summary card moved to `/projects` with the portfolio (ADR-172 D2);
    // the Desk's own tile-versus-badge case lives in `e2e/desk.spec.ts`.
    await page.goto("/projects");

    const railBadge = page.getByTestId("inbox-nav-badge");
    const summaryCount = page
      .getByTestId("decisions-count")
      .filter({ visible: true });

    await expect(railBadge).toBeVisible();
    await expect(summaryCount).toBeVisible();

    const rail = Number((await railBadge.textContent())?.trim());
    const summary = Number((await summaryCount.textContent())?.trim());

    expect(rail).toBeGreaterThan(0);
    expect(rail).toBe(summary);
  });
});
