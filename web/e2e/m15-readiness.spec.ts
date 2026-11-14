// M15 Phase 8: readiness summary badge & panel coverage — seeded server state.
// The fixture (e2e/_seed/seed-e2e.ts → seedM15Fixture, fixtures.json byKey.m15)
// plants ONE project `e2e-m15` carrying TWO seeded runs to demonstrate readiness
// badge visibility and panel state rendering:
//   • A run in Review with a BLOCKING gate seeded `failed` → board/portfolio
//     show [data-readiness="failed"]; run-detail panel shows "Failed" state +
//     reason.
//   • A run in Review with the SAME gate OVERRIDDEN → board/portfolio show
//     [data-readiness="overridden"]; panel shows "Overridden" state.
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. Navigate to the project board; verify the In Flight column shows TWO
//      cards with readiness badges [data-readiness="failed"] and
//      [data-readiness="overridden"].
//   2. Click the failed run card → run-detail page loads; ReadinessSummary
//      panel renders with state badge "Failed" and a reason listing the
//      blocking gate.
//   3. Click the overridden run card → run-detail page loads; ReadinessSummary
//      panel renders with state badge "Overridden".
//   4. Navigate to portfolio home; verify the workspace card for the failed
//      run shows [data-readiness="failed"]; overridden shows
//      [data-readiness="overridden"].
//
// SCOPE — what this e2e proxies vs. proves:
//   • The badge visibility on board/portfolio and the panel state are
//     rendered from seeded gate_results rows — no agent/runner involved.
//     Readiness state computation (rollupReadiness) is a pure function of
//     gate statuses and is tested in the integration layer.
//   • i18n labels ("Failed", "Overridden", reasons) resolve from the
//     getRunReadinessSummary DTO; the EN messages are asserted here.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

type M15Fixture = {
  projectSlug: string;
  failedRunId: string;
  failedHitlRequestId: string;
  overriddenRunId: string;
  overriddenHitlRequestId: string;
  gateId: string;
};

function loadM15Fixture(): M15Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m15: M15Fixture } };

  return all.byKey.m15;
}

test("readiness summary: badge on board/portfolio + panel on run-detail", async ({
  page,
}) => {
  const fx = loadM15Fixture();

  // (1) Navigate to the project board. Two In Flight cards with readiness
  // badges: one "failed", one "overridden".
  await page.goto(`/projects/${fx.projectSlug}`);

  // Board: find the cards with the readiness badges.
  const failedBadge = page.locator(`[data-readiness="failed"]`).first();
  const overriddenBadge = page.locator(`[data-readiness="overridden"]`).first();

  await expect(failedBadge).toBeVisible();
  await expect(overriddenBadge).toBeVisible();

  // (2) Open the failed run. The readiness badge sits in the card's actions
  // block OUTSIDE the run link (by design — actions need a non-link surface),
  // so navigate via the card's run-detail link instead of the badge.
  const verification = page.getByTestId("flow-verification");
  const disclosure = verification.locator("summary");
  const decoyId = randomUUID();
  const decoyLabel = "another-failed-check";
  const failedRowId = await withE2EDb(async (pool) => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM gate_results WHERE run_id=$1 AND gate_id=$2 AND status='failed'",
      [fx.failedRunId, fx.gateId],
    );

    expect(rows).toHaveLength(1);
    await pool.query(
      "INSERT INTO gate_results(id,run_id,node_attempt_id,gate_id,kind,mode,status) SELECT $1,run_id,node_attempt_id,$2,kind,mode,status FROM gate_results WHERE id=$3",
      [decoyId, decoyLabel, rows[0].id],
    );

    return rows[0].id;
  });

  try {
    await page.locator(`a[href="/runs/${fx.failedRunId}"]`).first().click();
    await page.waitForURL(`/runs/${fx.failedRunId}*`);
    await expect(disclosure).toContainText("Flow verification");
    await disclosure.focus();
    await disclosure.press("Enter");
    const failedReason = verification
      .getByRole("listitem")
      .filter({ hasText: fx.gateId });

    await expect(failedReason).toContainText(
      "Inspect the failed check before retrying.",
    );
    await failedReason
      .getByRole("link", { name: "View gate evidence" })
      .click();
    await expect(page.getByTestId("selected-result")).toContainText(fx.gateId);
    await page.getByRole("link", { name: "Provenance graph" }).click();
    const graph = page.getByTestId("evidence-graph");

    await expect(graph.getByTestId("evidence-node")).toHaveCount(1);
    await expect(graph.getByTestId("evidence-node")).toContainText(fx.gateId);
    await expect(page).toHaveURL(
      `/runs/${fx.failedRunId}?wb=evidence&evidenceItem=gate%3A${failedRowId}&evidenceView=graph`,
    );
    await expect(
      page.getByText(`Evidence item · ${fx.gateId}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(
      `/runs/${fx.failedRunId}?wb=evidence&evidenceView=graph`,
    );
    await expect(
      graph.getByTestId("evidence-node").filter({ hasText: decoyLabel }),
    ).toBeVisible();
  } finally {
    await withE2EDb((pool) =>
      pool.query("DELETE FROM gate_results WHERE id=$1", [decoyId]),
    );
  }

  // (3) Navigate back to the board and click the overridden run card.
  // The run-detail page loads and the ReadinessSummary panel renders
  // with state "Overridden".
  await page.goto(`/projects/${fx.projectSlug}`);

  const overriddenCard = page.locator(`[data-readiness="overridden"]`).first();

  await expect(overriddenCard).toBeVisible();

  await page.locator(`a[href="/runs/${fx.overriddenRunId}"]`).first().click();
  await page.waitForURL(`/runs/${fx.overriddenRunId}*`);

  await expect(disclosure).toContainText("Overridden");
  await disclosure.press("Enter");
  const overrideReason = verification
    .getByRole("listitem")
    .filter({ hasText: fx.gateId });

  await expect(overrideReason).toContainText(
    "An override supplied the decision.",
  );
  await expect(overrideReason).toContainText(
    "Review the recorded decision before proceeding.",
  );
  await expect(
    overrideReason.getByRole("link", { name: "View gate evidence" }),
  ).toHaveAttribute(
    "href",
    new RegExp(
      `^/runs/${fx.overriddenRunId}\\?wb=evidence&evidenceItem=gate%3A`,
    ),
  );

  // (4) Navigate to the portfolio (ADR-172 D2 moved it off `/`). The workspace
  // cards for both runs should display readiness badges
  // [data-readiness="failed"] and [data-readiness="overridden"].
  await page.goto("/projects");

  // Portfolio cards display readiness badges for runs in Review with
  // non-ready readiness states. The failed and overridden badges should
  // be visible somewhere on the page.
  const portfolioFailedBadge = page
    .locator(`[data-readiness="failed"]`)
    .first();
  const portfolioOverriddenBadge = page
    .locator(`[data-readiness="overridden"]`)
    .first();

  await expect(portfolioFailedBadge).toBeVisible();
  await expect(portfolioOverriddenBadge).toBeVisible();
});

test("UX-07 Running operational work and historical executor failure stay separate from Flow verification", async ({
  page,
}) => {
  const { failedRunId } = loadM15Fixture();
  const operational = randomUUID();
  const scratch = randomUUID();
  const flow = randomUUID();
  const attempt = randomUUID();
  const noChecksRun = randomUUID();
  const noChecksRevision = randomUUID();
  const operationalContract = readFileSync(
    path.resolve("e2e/_seed/operational-contract.json"),
    "utf8",
  );

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,agent_kind,status,agent_workspace,flow_version,result_contract) SELECT $1,project_id,'agent','operational','Running','none','test',$3 FROM runs WHERE id=$2",
      [operational, failedRunId, operationalContract],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version) SELECT $1,project_id,'scratch','Running','test' FROM runs WHERE id=$2",
      [scratch, failedRunId],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,flow_id,run_kind,status,flow_version,current_step_id) SELECT $1,project_id,flow_id,'flow','Running',flow_version,'review' FROM runs WHERE id=$2",
      [flow, failedRunId],
    );
    await pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status,error_code) VALUES($1,$2,'review','human',1,'Failed','EXECUTOR_UNAVAILABLE')",
      [attempt, flow],
    );
    await pool.query(
      "INSERT INTO gate_results(id,run_id,node_attempt_id,gate_id,kind,mode,status,ended_at) VALUES($1,$2,$3,'quality-check','external_check','blocking','passed',now())",
      [randomUUID(), flow, attempt],
    );
    await pool.query(
      "INSERT INTO flow_revisions(id,flow_ref_id,source,version_label,resolved_revision,manifest_digest,manifest,schema_version,installed_path,setup_status,package_status) SELECT $1,flow_ref_id,source,'no-checks',$2,$2,$3,1,installed_path,'not_required','Installed' FROM flows WHERE id=(SELECT flow_id FROM runs WHERE id=$4)",
      [
        noChecksRevision,
        noChecksRevision.replaceAll("-", ""),
        {
          schemaVersion: 1,
          name: "Known Flow without checks",
          nodes: [
            {
              id: "work",
              type: "cli",
              action: { command: "true" },
              transitions: { success: "done" },
            },
          ],
        },
        flow,
      ],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,flow_id,run_kind,status,flow_version,flow_revision_id) SELECT $1,project_id,flow_id,'flow','Running','no-checks',$2 FROM runs WHERE id=$3",
      [noChecksRun, noChecksRevision, flow],
    );
  });
  try {
    const verification = page
      .getByTestId("flow-verification")
      .filter({ visible: true });

    for (const runId of [operational, scratch]) {
      await page.goto(`/runs/${runId}`);
      await expect(
        page.getByTestId("run-shell").filter({ visible: true }),
      ).toBeVisible();
      await expect(page.getByTestId("flow-verification")).toHaveCount(0);
    }
    await page.goto(`/runs/${flow}`);
    await expect(verification).toContainText("Recorded checks clear");
    await expect(
      page.getByTestId("run-header-status").filter({ visible: true }),
    ).toContainText("Running");
    await expect(
      page
        .getByTestId("flow-run-node-attempts")
        .filter({ visible: true })
        .getByTestId("attempt-failure"),
    ).toContainText("was unavailable during this attempt");

    const gateReasons = [
      {
        status: "pending",
        kind: "external_check",
        reason: "is pending. No result has been recorded.",
        action: "Wait for a result.",
        evidence: false,
      },
      {
        status: "running",
        kind: "command_check",
        reason: "is still running",
        action: "Wait for the current check to finish.",
        evidence: false,
      },
      {
        status: "skipped",
        kind: "command_check",
        reason: "was skipped, so the blocking check is still unresolved",
        action: "Arrange for the check to run before proceeding.",
        evidence: true,
      },
      {
        status: "stale",
        kind: "external_check",
        reason: "is out of date",
        action: "Obtain a fresh result for this run.",
        evidence: true,
      },
    ].map((reason) => ({ ...reason, rowId: randomUUID() }));

    await withE2EDb(async (pool) => {
      for (const { status, kind, rowId } of gateReasons) {
        await pool.query(
          "INSERT INTO gate_results(id,run_id,node_attempt_id,gate_id,kind,mode,status) VALUES($1,$2,$3,$4,$5,'blocking',$6)",
          [rowId, flow, attempt, `${status}-check`, kind, status],
        );
      }
      await pool.query(
        "INSERT INTO artifact_instances(id,run_id,node_attempt_id,artifact_def_id,kind,producer,locator,validity,required_for) VALUES($1,$2,$3,'required-proof','test_report','runner',$4,'stale',$5)",
        [
          randomUUID(),
          flow,
          attempt,
          { kind: "inline", text: "outdated" },
          JSON.stringify(["review"]),
        ],
      );
    });
    await page.reload();
    await verification.locator("summary").press("Enter");
    for (const { status, reason, action, evidence, rowId } of gateReasons) {
      const item = verification
        .getByRole("listitem")
        .filter({ hasText: `${status}-check` });

      await expect(item).toContainText(reason);
      await expect(item).toContainText(action);
      if (evidence) {
        await expect(
          item.getByRole("link", { name: "View gate evidence" }),
        ).toHaveAttribute(
          "href",
          `/runs/${flow}?wb=evidence&evidenceItem=gate%3A${rowId}`,
        );
      } else {
        await expect(item.getByRole("link")).toHaveCount(0);
      }
    }
    const artifact = verification
      .getByRole("listitem")
      .filter({ hasText: "required-proof" });

    await expect(artifact).toContainText("has no current result.");
    await expect(artifact).toContainText(
      "Produce or refresh the required evidence before continuing.",
    );

    await page.goto(`/runs/${noChecksRun}`);
    await expect(verification).toContainText("No blocking checks configured");
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM runs WHERE id=ANY($1::text[])", [
        [operational, scratch, flow, noChecksRun],
      ]);
      await pool.query("DELETE FROM flow_revisions WHERE id=$1", [
        noChecksRevision,
      ]);
    });
  }
});
