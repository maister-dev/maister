import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  e2eClaudeRunnerSnapshot,
  seedDefaultRunSession,
  withE2EDb,
} from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type LocaleScenario = {
  locale: "en" | "ru";
  labels: {
    listHeading: string;
    labHeading: string;
    comparable: string;
    files: string;
    gates: string;
    cost: string;
    verdict: string;
    storedSnapshot: string;
    filesDifferent: string;
    confidence: string;
    tokensCaption: string;
    humanVerdict: string;
    submit: string;
    locked: string;
  };
};

type SeededExperiment = {
  slug: string;
  experimentId: string;
  title: string;
  comment: string;
};

const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VARIANTS = [
  { key: "control", label: "Control", config: {} },
  { key: "candidate", label: "Candidate", config: {} },
];
const RUBRIC = {
  criteria: [
    {
      id: "correctness",
      label: "Correctness",
      guidance: "Works as requested",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "spec_traceability",
      label: "Spec traceability",
      guidance: "Matches the implementation spec",
      scale: { min: 1, max: 5 },
      weight: 1,
      optional: true,
    },
  ],
};

const SCENARIOS: LocaleScenario[] = [
  {
    locale: "en",
    labels: {
      listHeading: "Experiments",
      labHeading: "Experiment lab",
      comparable: "Comparable",
      files: "Files",
      gates: "Gates",
      cost: "Cost",
      verdict: "Verdict",
      storedSnapshot: "Stored snapshot",
      filesDifferent: "Different",
      confidence: "Confidence",
      tokensCaption: "Tokens, not dollars",
      humanVerdict: "Human verdict",
      submit: "Conclude",
      locked: "Verdict is locked",
    },
  },
  {
    locale: "ru",
    labels: {
      listHeading: "Эксперименты",
      labHeading: "Лаборатория эксперимента",
      comparable: "Можно сравнивать",
      files: "Файлы",
      gates: "Гейты",
      cost: "Стоимость",
      verdict: "Вердикт",
      storedSnapshot: "Сохранённый снимок",
      filesDifferent: "Разные",
      confidence: "Уверенность",
      tokensCaption: "Токены, не доллары",
      humanVerdict: "Вердикт человека",
      submit: "Завершить",
      locked: "Вердикт зафиксирован",
    },
  },
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function setLocale(
  page: Page,
  baseURL: string | undefined,
  locale: LocaleScenario["locale"],
): Promise<void> {
  await page.context().addCookies([
    {
      name: "NEXT_LOCALE",
      value: locale,
      url: baseURL ?? "http://localhost:3100",
    },
  ]);
}

async function seedExperiment(
  scenario: LocaleScenario,
): Promise<SeededExperiment> {
  const fixtures = loadFixtures();
  const fx = fixtures.byKey.board;
  const suffix = `${scenario.locale}-${randomUUID().slice(0, 8)}`;
  const ids = {
    task: randomUUID(),
    experiment: randomUUID(),
    runControl: randomUUID(),
    runCandidate: randomUUID(),
    nodeControl: randomUUID(),
    nodeCandidate: randomUUID(),
    gateControl: randomUUID(),
    gateCandidate: randomUUID(),
    experimentRunControl: randomUUID(),
    experimentRunCandidate: randomUUID(),
  };
  const title = `E2E ${scenario.locale.toUpperCase()} experiment ${suffix}`;
  const comment = `Human verdict ${suffix}`;
  const controlDiff = [
    "diff --git a/src/feature.ts b/src/feature.ts",
    "+control path keeps the existing flow",
  ].join("\n");
  const candidateDiff = [
    "diff --git a/src/feature.ts b/src/feature.ts",
    "+candidate path adds the studio comparison",
  ].join("\n");

  await withE2EDb(async (pool) => {
    await pool.query(
      `WITH alloc AS (
         UPDATE projects SET next_task_number = next_task_number + 1
         WHERE id = $2 RETURNING next_task_number - 1 AS n
       )
       INSERT INTO tasks
         (id, project_id, number, title, prompt, flow_id, status, stage, created_by_user_id)
       SELECT $1, $2, alloc.n, $3, $4, $5, 'InFlight', 'Backlog', $6 FROM alloc`,
      [
        ids.task,
        fx.projectId,
        `${title} task`,
        "Compare two variants in the experiment studio.",
        fx.flowId,
        fixtures.users.admin.id,
      ],
    );

    await pool.query(
      `INSERT INTO runs
         (id, run_kind, task_id, project_id, flow_id, status, current_step_id,
          flow_version, flow_revision, created_by_user_id, started_at, ended_at)
       VALUES
         ($1, 'flow', $2, $3, $4, 'Review', 'review', 'v1.0.0', 'e2e', $5,
          now() - interval '6 minutes', now() - interval '3 minutes'),
         ($6, 'flow', $2, $3, $4, 'Review', 'review', 'v1.0.0', 'e2e', $5,
          now() - interval '5 minutes', now() - interval '1 minute')`,
      [
        ids.runControl,
        ids.task,
        fx.projectId,
        fx.flowId,
        fixtures.users.admin.id,
        ids.runCandidate,
      ],
    );

    await seedDefaultRunSession(pool, {
      capabilityAgent: "claude",
      runId: ids.runControl,
      runnerId: fx.runnerId,
      runnerSnapshot: {
        ...e2eClaudeRunnerSnapshot(fx.runnerId),
        label: "Control runner",
      },
    });
    await seedDefaultRunSession(pool, {
      capabilityAgent: "claude",
      runId: ids.runCandidate,
      runnerId: fx.runnerId,
      runnerSnapshot: {
        ...e2eClaudeRunnerSnapshot(fx.runnerId),
        label: "Candidate runner",
      },
    });

    await pool.query(
      `INSERT INTO node_attempts
         (id, run_id, node_id, node_type, attempt, status)
       VALUES
         ($1, $2, 'review', 'judge', 1, 'Succeeded'),
         ($3, $4, 'review', 'judge', 1, 'Succeeded')`,
      [ids.nodeControl, ids.runControl, ids.nodeCandidate, ids.runCandidate],
    );

    await pool.query(
      `INSERT INTO gate_results
         (id, run_id, node_attempt_id, gate_id, kind, mode, status, verdict, ended_at)
       VALUES
         ($1, $2, $3, 'quality', 'ai_judgment', 'blocking', 'passed',
          $4::jsonb, now() - interval '2 minutes'),
         ($5, $6, $7, 'quality', 'ai_judgment', 'blocking', 'passed',
          $8::jsonb, now() - interval '1 minute')`,
      [
        ids.gateControl,
        ids.runControl,
        ids.nodeControl,
        json({ verdict: "pass", confidence: 0.82 }),
        ids.gateCandidate,
        ids.runCandidate,
        ids.nodeCandidate,
        json({ verdict: "pass", confidence: 0.93 }),
      ],
    );

    await pool.query(
      `INSERT INTO run_cost_rollups
         (run_id, project_id, task_id, flow_id, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, by_model, by_runner,
          source_event_count)
       VALUES
         ($1, $2, $3, $4, 1000, 250, 50, 20, $5::jsonb, $6::jsonb, 3),
         ($7, $2, $3, $4, 1200, 320, 80, 25, $8::jsonb, $9::jsonb, 4)`,
      [
        ids.runControl,
        fx.projectId,
        ids.task,
        fx.flowId,
        json({ "gpt-5": { input: 1000, output: 250 } }),
        json({ "Control runner": { input: 1000, output: 250 } }),
        ids.runCandidate,
        json({ "gpt-5": { input: 1200, output: 320 } }),
        json({ "Candidate runner": { input: 1200, output: 320 } }),
      ],
    );

    await pool.query(
      `INSERT INTO experiments
         (id, project_id, task_id, title, description, base_branch, base_commit,
          status, variants, rubric, created_by_user_id, launched_at,
          comparable_at)
       VALUES
         ($1, $2, $3, $4, $5, 'main', $6, 'comparable', $7::jsonb,
          $8::jsonb, $9, now() - interval '5 minutes', now() - interval '1 minute')`,
      [
        ids.experiment,
        fx.projectId,
        ids.task,
        title,
        "Seeded by the experiment-comparison Playwright spec.",
        BASE_COMMIT,
        json(VARIANTS),
        json(RUBRIC),
        fixtures.users.admin.id,
      ],
    );

    await pool.query(
      `INSERT INTO experiment_runs
         (id, experiment_id, run_id, variant_key, replicate_ordinal,
          launch_reason, base_commit, diff_snapshot, diff_snapshot_truncated,
          diff_snapshot_bytes, diff_snapshot_captured_at, diff_files_summary,
          materialization_delta)
       VALUES
         ($1, $2, $3, 'control', 1, 'initial', $4, $5, false, $6, now(),
          $7::jsonb, $8::jsonb),
         ($9, $2, $10, 'candidate', 1, 'initial', $4, $11, true, $12, now(),
          $13::jsonb, $14::jsonb)`,
      [
        ids.experimentRunControl,
        ids.experiment,
        ids.runControl,
        BASE_COMMIT,
        controlDiff,
        controlDiff.length,
        json([
          {
            path: "src/feature.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "control-feature",
          },
        ]),
        json({
          experimentId: ids.experiment,
          variantKey: "control",
          added: { rules: [], skills: [], mcps: [], subagents: [] },
          removed: { rules: [], skills: [], mcps: [], subagents: [] },
        }),
        ids.experimentRunCandidate,
        ids.runCandidate,
        candidateDiff,
        candidateDiff.length,
        json([
          {
            path: "src/feature.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "candidate-feature",
          },
          {
            path: "docs/experiment.md",
            status: "added",
            additions: 3,
            deletions: 0,
            patchHash: "candidate-doc",
          },
        ]),
        json({
          experimentId: ids.experiment,
          variantKey: "candidate",
          added: { rules: [], skills: ["aif-plan"], mcps: [], subagents: [] },
          removed: { rules: [], skills: [], mcps: [], subagents: [] },
        }),
      ],
    );
  });

  return {
    slug: fx.projectSlug,
    experimentId: ids.experiment,
    title,
    comment,
  };
}

for (const scenario of SCENARIOS) {
  test(`experiment comparison studio flow renders and concludes in ${scenario.locale}`, async ({
    page,
    baseURL,
  }) => {
    const seeded = await seedExperiment(scenario);

    await setLocale(page, baseURL, scenario.locale);
    await page.goto(`/projects/${seeded.slug}/experiments`);

    await expect(
      page.getByRole("heading", { name: scenario.labels.listHeading }),
    ).toBeVisible();

    const row = page
      .getByTestId("experiment-row")
      .filter({ hasText: seeded.title });

    await expect(row).toContainText(seeded.title);
    await expect(row).toContainText(scenario.labels.comparable);

    await row.getByRole("link", { name: seeded.title }).click();
    await page.waitForURL(
      `/projects/${seeded.slug}/experiments/${seeded.experimentId}*`,
    );

    await expect(page.getByText(scenario.labels.labHeading)).toBeVisible();
    await expect(page.getByRole("heading", { name: seeded.title })).toBeVisible();
    await expect(
      page.getByText(scenario.labels.storedSnapshot, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("candidate path adds the studio comparison")).toBeVisible();

    await page.getByRole("tab", { name: scenario.labels.files }).click();
    await expect(page.getByText("docs/experiment.md")).toBeVisible();
    await expect(
      page.getByText(scenario.labels.filesDifferent, { exact: true }).first(),
    ).toBeVisible();

    await page.getByRole("tab", { name: scenario.labels.gates }).click();
    await expect(page.getByText("ai_judgment").first()).toBeVisible();
    await expect(page.getByText(scenario.labels.confidence).first()).toBeVisible();

    await page.getByRole("tab", { name: scenario.labels.cost }).click();
    await expect(page.getByText(scenario.labels.tokensCaption).first()).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "gpt-5" }).first()).toBeVisible();

    await page.getByRole("tab", { name: scenario.labels.verdict }).click();
    await expect(page.getByText(scenario.labels.humanVerdict)).toBeVisible();
    await page.locator('select[name="winnerVariantKey"]').selectOption("candidate");
    await page.locator('input[name="score.correctness.control"]').fill("4");
    await page.locator('input[name="score.correctness.candidate"]').fill("5");
    await page.locator('input[name="score.spec_traceability.control"]').fill("3");
    await page.locator('input[name="score.spec_traceability.candidate"]').fill("5");
    await page.locator('textarea[name="comment"]').fill(seeded.comment);

    const concludeResponse = page.waitForResponse(
      (response) =>
        response.url().includes(
          `/api/projects/${seeded.slug}/experiments/${seeded.experimentId}/conclude`,
        ) && response.request().method() === "POST",
    );

    await page.getByTestId("verdict-submit").click();
    expect((await concludeResponse).status()).toBe(200);

    await expect(page.getByText(scenario.labels.locked)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(seeded.comment)).toBeVisible();
  });
}
