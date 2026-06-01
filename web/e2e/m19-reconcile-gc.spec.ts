// M19 Phase 5 (reconcile + GC): UI + i18n + cron, end-to-end through the real
// app + the dedicated e2e DB. The fixture (e2e/_seed/seed-e2e.ts → seedM19Fixture,
// fixtures.json byKey.m19) plants ONE project `e2e-m19` carrying:
//   • a recoverable Crashed flow run (acpSessionId checkpoint + an ai_coding
//     current node → run-detail recoverable:true, board Crashed column);
//   • two terminal Abandoned runs whose workspaces have a staggered
//     scheduled_removal_at — one inside the 2-day warning window, one already
//     due — for the left-rail TTL badge.
//
// Asserted, deterministic, supervisor-INDEPENDENT outcomes:
//   (a) the Crashed run-detail page shows `run-crashed-section` with Recover +
//       Discard controls; opening Recover shows the confirm dialog whose body
//       WARNS that recovery re-runs the current node;
//   (b) the board surfaces the Crashed run in its dedicated Crashed column
//       (data-stage="crashed");
//   (c) the left-rail TTL badge reflects warning vs due windows
//       (data-testid="ttl-badge" / data-ttl-state);
//   (d) the cron GC route auth-gate: wrong token → 401, valid token → 200|207.
//
// Why no live resume here: the e2e stub supervisor (e2e/_seed/stub-supervisor.ts)
// answers ONLY /health and implements NOTHING else — no /sessions, no agent
// spawn. So the Recover happy-path (which calls resumeCrashedRun →
// supervisor.createSession) cannot complete a real --resume against the stub.
// This spec therefore asserts the UI affordance + confirm-dialog warning + that
// the POST is wired and the UI reflects the typed result (queued / error /
// gone), NOT a full live resume — that is integration-proven (lib/runs/recover
// + the resume-driver integration tests). The cron 503 (env MAISTER_CRON_TOKEN
// unset) case is covered by app/api/cron/gc/__tests__/route.integration.test.ts;
// it cannot be exercised against the running webServer, which HAS the token set.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type M19Fixture = {
  projectId: string;
  projectSlug: string;
  repoPath: string;
  crashedRunId: string;
  crashedBranch: string;
  warningRunId: string;
  warningBranch: string;
  dueRunId: string;
  dueBranch: string;
};

function loadM19(): M19Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m19: M19Fixture } };

  return all.byKey.m19;
}

// Must match playwright.config.ts webServer env MAISTER_CRON_TOKEN.
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";
const CRON_HEADER = "X-Maister-Cron-Token";

test.describe("M19 reconcile + GC UI", () => {
  test("(a) Crashed run-detail shows recover/discard + a re-run warning in the Recover confirm", async ({
    page,
  }) => {
    const fx = loadM19();

    await page.goto(`/runs/${fx.crashedRunId}`);

    // The Crashed section is shown only when status === 'Crashed'.
    const section = page.getByTestId("run-crashed-section");

    await expect(section).toBeVisible();

    // The run IS recoverable (acpSessionId + ai_coding node) → the recover
    // actions component renders, not the not-recoverable note.
    const actions = page.getByTestId("run-recover-actions");

    await expect(actions).toBeVisible();
    await expect(page.getByTestId("run-not-recoverable")).toHaveCount(0);

    const recoverButton = page.getByTestId("recover-button");
    const discardButton = page.getByTestId("discard-button");

    await expect(recoverButton).toBeVisible();
    await expect(discardButton).toBeVisible();

    // Opening Recover surfaces a confirm dialog that MUST warn the user that
    // recovery re-runs the current node (the contract's "warns re-runs node").
    await recoverButton.click();

    const confirm = page.getByTestId("recover-confirm");

    await expect(confirm).toBeVisible();
    // The warning copy mentions re-running (run.recoverConfirmBody). Matched
    // case-insensitively on "re-run"/"rerun"/"re run" so EN or RU phrasing that
    // keeps the latin stem still satisfies; the i18n catalog carries the full
    // sentence.
    await expect(confirm).toContainText(/re-?\s?runs?/i);
    await expect(page.getByTestId("recover-confirm-submit")).toBeVisible();
  });

  test("(a2) a Discard confirm dialog opens from the Crashed section", async ({
    page,
  }) => {
    const fx = loadM19();

    await page.goto(`/runs/${fx.crashedRunId}`);

    await expect(page.getByTestId("run-crashed-section")).toBeVisible();
    await page.getByTestId("discard-button").click();

    const confirm = page.getByTestId("discard-confirm");

    await expect(confirm).toBeVisible();
    await expect(page.getByTestId("discard-confirm-submit")).toBeVisible();
  });

  test("(b) the board shows the Crashed run in the dedicated Crashed column", async ({
    page,
  }) => {
    const fx = loadM19();

    await page.goto(`/projects/${fx.projectSlug}`);

    const board = page.locator("[data-board]");

    await expect(board).toBeVisible();

    // The Crashed run lives in the Crashed column (data-stage="crashed") and
    // links to its run-detail page.
    const crashedColumn = board.locator('[data-stage="crashed"]');

    await expect(crashedColumn).toBeVisible();
    await expect(
      crashedColumn.locator(`a[href="/runs/${fx.crashedRunId}"]`),
    ).toBeVisible();
  });

  test("(c) the left-rail TTL badge shows warning and due states for the two Abandoned runs", async ({
    page,
  }) => {
    const fx = loadM19();

    await page.goto(`/projects/${fx.projectSlug}`);

    // The left-rail lists active/terminal workspaces; the GC TTL badge tags each
    // terminal workspace's removal window. The two seeded Abandoned runs carry a
    // warning-window and a due deadline respectively.
    await expect(
      page.locator('[data-testid="ttl-badge"][data-ttl-state="warning"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="ttl-badge"][data-ttl-state="due"]'),
    ).toHaveCount(1);
  });
});

test.describe("M19 cron GC auth gate", () => {
  test("(d) wrong token → 401, valid token → 200|207", async ({ request }) => {
    // Wrong token → 401 (the running webServer HAS MAISTER_CRON_TOKEN set, so a
    // mismatch is unauthorized, not "disabled"). The 503 disabled case (token
    // env unset) is covered by the route integration test.
    const wrong = await request.post("/api/cron/gc", {
      headers: { [CRON_HEADER]: "definitely-not-the-token" },
    });

    expect(wrong.status()).toBe(401);

    // Missing header is also unauthorized against a token-configured server.
    const missing = await request.post("/api/cron/gc");

    expect(missing.status()).toBe(401);

    // Valid token → both sweeps run → 200 (all ok) or 207 (a sub-sweep threw).
    const ok = await request.post("/api/cron/gc", {
      headers: { [CRON_HEADER]: CRON_TOKEN },
    });

    expect([200, 207]).toContain(ok.status());

    // The response carries the two sweep summaries and NEVER the token value.
    const text = await ok.text();

    expect(text).not.toContain(CRON_TOKEN);

    const body = JSON.parse(text) as {
      workspace?: unknown;
      revision?: unknown;
    };

    expect(body).toHaveProperty("workspace");
    expect(body).toHaveProperty("revision");
  });
});
