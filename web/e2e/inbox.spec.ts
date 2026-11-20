import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

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

function loadReviewFixture(): { runId: string } {
  return (
    JSON.parse(
      readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
    ) as { byKey: { reviewComments: { runId: string } } }
  ).byKey.reviewComments;
}

test("AV-04 applies a webhook run's pending note through Inbox while the amber count stays fixed", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const runId = randomUUID();
  const projectId = randomUUID();
  const slug = `inbox-vault-${projectId.slice(0, 8)}`;
  const agentId = `fixture:${slug}`;
  const token = generateToken();

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1) ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$2,'Inbox vault fixture',$3,$4)",
      [
        projectId,
        slug,
        `/tmp/${slug}`,
        `VR${projectId.slice(0, 7).toUpperCase()}`,
      ],
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

  await page.goto(
    `/inbox?${new URLSearchParams({ kind: "vault", projectId, agentId })}`,
  );
  const rail = page.locator('nav[aria-label="Sections"]');
  const decisions = rail.getByTestId("inbox-nav-badge");
  const reviews = rail.getByTestId("reviews-nav-badge");
  const before = await decisions.textContent();
  const reviewBefore =
    (await reviews.count()) === 0 ? 0 : Number(await reviews.textContent());
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

  await expect(reviews).toHaveText(String(reviewBefore + 1), {
    timeout: 45_000,
  });
  await expect(decisions).toHaveText(before!);
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
  await group.getByRole("checkbox", { name: pathname }).check();
  const settled = page.waitForResponse("**/api/inbox/reviews/decisions", {
    timeout: 30_000,
  });

  await group.getByRole("button", { name: "Accept selected" }).click();
  expect((await settled).ok()).toBe(true);
  await expect(group.getByText("Accepted", { exact: false })).toBeVisible();
  if (reviewBefore === 0)
    await expect(reviews).toHaveCount(0, { timeout: 45_000 });
  else
    await expect(reviews).toHaveText(String(reviewBefore), { timeout: 45_000 });
  await expect(decisions).toHaveText(before!);
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
    const review = loadReviewFixture();

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ visible: true })
      .filter({
        has: page.locator(
          `a[href="/runs/${review.runId}?wb=review&scope=review"]`,
        ),
      });

    await expect(card).toHaveCount(1);
    await expect(card.getByRole("link", { name: "Review code" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Respond" })).toHaveCount(0);

    await card.getByRole("link", { name: "Review code" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/runs/${review.runId}\\?wb=review&scope=review`),
    );
    await expect(
      page.getByRole("region", { name: "Review workspace" }),
    ).toBeVisible();
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
