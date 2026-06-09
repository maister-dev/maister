// M16 Phase 8 (T8.1): the external-operations API, end-to-end through the real
// app + the dedicated e2e DB. The fixture (e2e/_seed/seed-e2e.ts →
// seedM16Fixture, fixtures.json byKey.m16) plants ONE project `e2e-m16`
// carrying:
//   • a LAUNCHABLE Backlog task (real on-disk git repo + enabled flow revision)
//     so the token-authed task-create + run-launch reach a real 201/202; and
//   • a review run parked at a `review` human node whose pre_finish declares a
//     BLOCKING external_check gate seeded `pending` (gate_results) plus a
//     pending human_review HITL — the supervisor-INDEPENDENT vehicle for the
//     readiness / gate-report / re-stale / evidence steps.
//
// Asserted, deterministic, supervisor-independent outcomes (in sequence):
//   1. session-auth token create → one-time secret captured (UI tab also loads);
//      scoped user token creation → metadata renders in the Integrations table;
//   2. Bearer task-create → 201 {taskId};
//   3. Bearer run-launch against the launchable Backlog task → 202 {runId,...};
//   4. Bearer readiness on the seeded run → external gate pending, NOT ready;
//   5. Bearer gate-report {status:"passed",commitSha,...} → 200 {gateId,status,artifactId};
//   6. re-GET readiness → external gate passed, readiness clears (allow-list);
//   7. /runs/<id> evidence graph surfaces the test_report artifact from step 5;
//   8. re-report with a DIFFERENT commitSha → prior passed row superseded; the
//      latest representative governs (readiness still passed, fresh commit).
//   + auth-negative sanity: garbage Bearer → 401 on an ext route.
//
// SCOPE — what this e2e proxies vs. proves (the literal transitions are covered
// at the integration layer, which CAN drive the runner chokepoint):
//   • Steps 4/6 PROXY "review approval refused-while-pending → allowed-after-
//     passed" via the readiness DTO. The literal approve→refused/allowed
//     transition is NOT driven here: the stub-supervisor e2e cannot
//     synchronously observe the deferred runner refusal (assertEvidenceReady
//     runs inside runFlow, not on the HITL respond response). The literal
//     criterion is exercised in
//     web/lib/flows/graph/__tests__/external-check-loop.integration.test.ts.
//     Readiness "ready" (step 6) means evidence no longer blocks review — NOT
//     that the human-review HITL was approved (the rollup ignores pending HITL).
//   • Step 3's 202 proves the token-authed launch CONTRACT + preconditions +
//     supervisor /health; it does NOT prove an ACP session spawned (the stub
//     answers only /health — session lifecycle is out of e2e scope).
//   • Step 8 asserts the latest representative governs (readiness stays passed on
//     the new commit); the stale-prior + append supersede MECHANISM is proven in
//     external-check-supersede-readiness.integration.test.ts.
//
// Token creation goes through the reliable API path (POST
// /api/projects/{slug}/tokens, session-auth via the seeded admin storageState)
// — the secret is shown once and must be captured for the Bearer calls. The
// run-launch (step 3) reuses the same enabled-flow path the board fixture
// proves launchable under the stub supervisor (/health ready, no agent spawn),
// so it lands a real 202; steps 4-8 drive the SEEDED parked-review run + its
// external_check gate, which need no worktree and no agent.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type M16Fixture = {
  projectSlug: string;
  launchTaskId: string;
  flowId: string;
  runId: string;
  hitlRequestId: string;
  gateId: string;
};

type TokenCreateBody = {
  id: string;
  token: string;
  kind: "project" | "user";
  ownerLabel: string | null;
  scopes: string[];
};

function loadM16Fixture(): M16Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m16: M16Fixture } };

  return all.byKey.m16;
}

test("external-operations API: token → task → launch → readiness gate report → re-stale", async ({
  page,
  request,
}) => {
  const fx = loadM16Fixture();

  // (auth-negative) A garbage Bearer is unauthenticated on an ext route.
  const noAuth = await request.get(`/api/v1/ext/runs/${fx.runId}/readiness`, {
    headers: { authorization: "Bearer totally-invalid" },
  });

  expect(noAuth.status()).toBe(401);

  // (1a) The Integrations tab renders for the seeded admin (nice-to-have UI
  // touch): the "API tokens" panel + the admin-only create affordance.
  await page.goto(`/projects/${fx.projectSlug}?tab=integrations`);
  await expect(
    page.getByRole("heading", { name: "API tokens", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create token", exact: true }),
  ).toBeVisible();

  // (1b) Create a project token via the session-authed API. The plaintext
  // secret is returned exactly once — capture it for the Bearer calls.
  const tokenRes = await request.post(
    `/api/projects/${fx.projectSlug}/tokens`,
    { data: { name: "e2e-m16-ci" } },
  );

  expect(tokenRes.status()).toBe(201);

  const tokenBody = (await tokenRes.json()) as TokenCreateBody;

  expect(typeof tokenBody.token).toBe("string");
  expect(tokenBody.token.length).toBeGreaterThan(0);

  const auth = { authorization: `Bearer ${tokenBody.token}` };

  // (1c) Create a user-owned token with only tasks:create. Its owner/scope
  // metadata must be visible in the Integrations table, and the scope must be
  // enforced by the external API.
  const userTokenRes = await request.post(
    `/api/projects/${fx.projectSlug}/tokens`,
    {
      data: {
        name: "e2e-personal-webhook",
        kind: "user",
        scopes: ["tasks:create"],
      },
    },
  );

  expect(userTokenRes.status()).toBe(201);

  const userTokenBody = (await userTokenRes.json()) as TokenCreateBody;

  expect(userTokenBody).toMatchObject({
    kind: "user",
    ownerLabel: "E2E Admin",
    scopes: ["tasks:create"],
  });

  await page.goto(`/projects/${fx.projectSlug}?tab=integrations`);
  const userTokenRow = page
    .getByRole("row")
    .filter({ hasText: "e2e-personal-webhook" });

  await expect(userTokenRow).toBeVisible();
  await expect(userTokenRow).toContainText("User token");
  await expect(userTokenRow).toContainText("E2E Admin");
  await expect(userTokenRow).toContainText("Create tasks");

  const userAuth = { authorization: `Bearer ${userTokenBody.token}` };

  const scopedTaskRes = await request.post(
    `/api/v1/ext/projects/${fx.projectSlug}/tasks`,
    {
      headers: userAuth,
      data: {
        title: "External user token task",
        prompt: "Created by a user-owned webhook token.",
        flowId: fx.flowId,
      },
    },
  );

  expect(scopedTaskRes.status()).toBe(201);

  const deniedRead = await request.get(
    `/api/v1/ext/projects/${fx.projectSlug}/tasks`,
    { headers: userAuth },
  );

  expect(deniedRead.status()).toBe(403);

  // (2) Token-auth task create against the launchable flow.
  const taskRes = await request.post(
    `/api/v1/ext/projects/${fx.projectSlug}/tasks`,
    {
      headers: auth,
      data: {
        title: "External task",
        prompt: "Do the external thing.",
        flowId: fx.flowId,
      },
    },
  );

  expect(taskRes.status()).toBe(201);

  const taskBody = (await taskRes.json()) as { taskId: string };

  expect(typeof taskBody.taskId).toBe("string");

  // (3) Token-auth run launch against the SEEDED launchable Backlog task (its
  // enabled flow revision + real on-disk worktree make the launch deterministic
  // under the stub supervisor — /health ready, no agent spawn). 202 Accepted.
  const launchRes = await request.post(`/api/v1/ext/runs`, {
    headers: auth,
    data: { taskId: fx.launchTaskId },
  });

  expect(launchRes.status()).toBe(202);

  const launchBody = (await launchRes.json()) as {
    runId: string;
    status: string;
  };

  expect(typeof launchBody.runId).toBe("string");
  expect(launchBody.status).toBeTruthy();

  // (4) Readiness on the SEEDED review run is BLOCKED while the external gate is
  // pending: the gate appears pending in externalGates[] and readiness is not
  // "ready" (the blocking external_check gate gates review by allow-list).
  const r1 = await request.get(`/api/v1/ext/runs/${fx.runId}/readiness`, {
    headers: auth,
  });

  expect(r1.status()).toBe(200);

  const ready1 = (await r1.json()) as {
    readiness: string;
    externalGates: { gateId: string; status: string }[];
  };

  expect(ready1.readiness).not.toBe("ready");

  const gate1 = ready1.externalGates.find((g) => g.gateId === fx.gateId);

  expect(gate1?.status).toBe("pending");

  // (5) Report the external gate PASSED. 200 with the gate id, status, and the
  // recorded test_report artifact id.
  const report1 = await request.post(
    `/api/v1/ext/runs/${fx.runId}/gates/${fx.gateId}/report`,
    {
      headers: auth,
      data: {
        status: "passed",
        commitSha: "commit-aaa",
        externalRunUrl: "https://ci.example/run/1",
        summary: "42 passed, 0 failed",
      },
    },
  );

  expect(report1.status()).toBe(200);

  const reportBody = (await report1.json()) as {
    gateId: string;
    status: string;
    artifactId: string;
  };

  expect(reportBody).toMatchObject({ gateId: fx.gateId, status: "passed" });
  expect(typeof reportBody.artifactId).toBe("string");

  // (6) Re-GET readiness → the external gate now reads `passed` and readiness
  // clears (allow-list: passed/overridden satisfy the blocking gate).
  const r2 = await request.get(`/api/v1/ext/runs/${fx.runId}/readiness`, {
    headers: auth,
  });

  expect(r2.status()).toBe(200);

  const ready2 = (await r2.json()) as {
    readiness: string;
    externalGates: { gateId: string; status: string; commitSha?: string }[];
  };

  const gate2 = ready2.externalGates.find((g) => g.gateId === fx.gateId);

  expect(gate2?.status).toBe("passed");
  expect(gate2?.commitSha).toBe("commit-aaa");
  expect(ready2.readiness).toBe("ready");

  // (7) The evidence graph surfaces the test_report artifact from the report.
  // React Flow only mounts nodes inside the fitView viewport; scope the graph to
  // artifact nodes (URL filter) and assert on the artifact node by its id.
  await page.goto(`/runs/${fx.runId}?kind=artifact`);
  await expect(page.locator('[data-testid="evidence-graph"]')).toBeVisible();

  const reportNode = page.locator(
    `[data-testid="evidence-node"][data-artifact-id="${reportBody.artifactId}"]`,
  );

  await expect(reportNode).toBeVisible();
  await expect(reportNode).toHaveAttribute("data-kind", "artifact");
  await expect(reportNode).toContainText("test_report");

  // (8) Re-stale on a NEW commit: report PASSED again with a DIFFERENT commitSha.
  // The prior passed row is re-staled and a fresh row appended; the LATEST
  // representative governs, so readiness stays `passed` on the new commit.
  const report2 = await request.post(
    `/api/v1/ext/runs/${fx.runId}/gates/${fx.gateId}/report`,
    {
      headers: auth,
      data: {
        status: "passed",
        commitSha: "commit-bbb",
        externalRunUrl: "https://ci.example/run/2",
        summary: "43 passed, 0 failed",
      },
    },
  );

  expect(report2.status()).toBe(200);

  const r3 = await request.get(`/api/v1/ext/runs/${fx.runId}/readiness`, {
    headers: auth,
  });

  expect(r3.status()).toBe(200);

  const ready3 = (await r3.json()) as {
    readiness: string;
    externalGates: { gateId: string; status: string; commitSha?: string }[];
  };

  const gate3 = ready3.externalGates.find((g) => g.gateId === fx.gateId);

  // The latest report governs: still passed, but now on the new commit (the
  // superseded prior `passed` row is collapsed out of the projection).
  expect(gate3?.status).toBe("passed");
  expect(gate3?.commitSha).toBe("commit-bbb");
  expect(ready3.readiness).toBe("ready");
});
