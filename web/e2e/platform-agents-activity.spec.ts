import { rm, readdir, readFile, mkdir, writeFile, cp } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { STUB_SESSIONS_DIR } from "./_seed/stub-supervisor";
import { withE2EDb } from "./_seed/db";

import { git, initRepo } from "@/test-support/git-fixture";

// Projection scenarios cover retained history; the retry journey drives the real
// API and controlled supervisor. PG/Git suites own adversarial lifecycle checks.
const projectId = randomUUID();
const slug = `agent-activity-${projectId.slice(0, 8)}`;
const agentId = `fixture:triager-${projectId.slice(0, 8)}`;
const activeStatuses = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
] as const;
const activeIds = activeStatuses.map(() => randomUUID());
let addedHistoryRuns = 0;
const failedIds = Array.from({ length: 20 }, () => randomUUID());

test.describe("Agent execution visibility and retained history", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    await initRepo(`/tmp/${slug}`);
    await writeFile(
      `/tmp/${slug}/README.md`,
      "# Fixture source\nCurrent behavior and acceptance evidence for request qualification.\n",
    );
    await git(`/tmp/${slug}`, "add", "README.md");
    await git(`/tmp/${slug}`, "commit", "-m", "Seed qualification evidence");
  });
  test.beforeAll(async () =>
    withE2EDb(async (pool) => {
      await pool.query(
        "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$2,'Agent Activity UI',$3,$4)",
        [
          projectId,
          slug,
          `/tmp/${slug}`,
          `AA${projectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
        ],
      );
      await pool.query(
        "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES ($1,'fixture','v1','git','Intake triager','Activity fixture','none','session','[\"manual\"]','read_only','/unused/triager.md')",
        [agentId],
      );
      await pool.query(
        "INSERT INTO agent_project_links(id,project_id,agent_id) VALUES ($1,$2,$3)",
        [randomUUID(), projectId, agentId],
      );
      for (const [index, id] of [...activeIds, ...failedIds].entries()) {
        const state =
          index < activeIds.length ? activeStatuses[index] : "Failed";
        const snapshot = {
          version: 1,
          agentId,
          displayName: "Intake triager",
          definitionSha256: "a".repeat(64),
          packageInstallId: "fixture",
          packageName: "fixture",
          packageVersion: "v1",
          packageRevision: "a".repeat(40),
        };

        await pool.query(
          "INSERT INTO runs(id,project_id,run_kind,agent_id,agent_workspace,status,flow_version,source_agent_id,agent_activity_snapshot,launched_at,activity_sort_at,activity_timestamp_provenance,ended_at) VALUES ($1,$2,'agent',$3,'none',$4,'agent',$3,$5,now()-($6::int*interval '1 second'),now()-($6::int*interval '1 second'),'launch',CASE WHEN $4='Failed' THEN now() ELSE NULL END)",
          [id, projectId, agentId, state, JSON.stringify(snapshot), index],
        );
      }
    }),
  );
  test.beforeAll(async () =>
    withE2EDb(async (pool) => {
      for (let index = 0; index < 13; index++) {
        const episodeId = randomUUID();

        await pool.query(
          "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES($1,$2,$3,'unknown','unknown',$4,'runner_unavailable')",
          [episodeId, projectId, agentId, String(index).padStart(64, "0")],
        );
        await pool.query(
          "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,original_run_id,run_id,channel,observed_at) SELECT $1,'ui:'||$1||':'||id,$2,id,id,'execution_failure',now() FROM runs WHERE id=ANY($3::text[])",
          [episodeId, String(index).padStart(64, "0"), failedIds],
        );
      }
    }),
  );
  test.afterAll(async () =>
    withE2EDb(async (pool) => {
      // The harness owns and removes this disposable database, including protected execution evidence.
      await pool.query(
        "UPDATE agent_project_links SET enabled=false WHERE project_id=$1",
        [projectId],
      );
      await pool.query(
        "UPDATE runs SET status='Abandoned',ended_at=now() WHERE id=ANY($1::text[]) AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren')",
        [activeIds],
      );
      // A failed test retains its still-registered checkout for the outer harness.
      if (
        (await git(`/tmp/${slug}`, "worktree", "list", "--porcelain")).split(
          "worktree ",
        ).length === 2
      )
        await rm(`/tmp/${slug}`, { recursive: true, force: true });
    }),
  );
  for (const locale of ["en", "ru"] as const) {
    test(`E2E-UX-01 all six active states, collapsed/mobile parity and SSE removal (${locale})`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      await withE2EDb((pool) =>
        pool.query(
          "UPDATE runs SET status='NeedsInputIdle',ended_at=NULL WHERE id=$1",
          [activeIds[3]],
        ),
      );
      await page.goto(`/projects/${slug}`);
      const rail = page.getByTestId("left-rail");

      await expect(rail.locator("[data-agent-run-id]")).toHaveCount(6);
      for (const id of activeIds)
        await expect(rail.locator(`[data-agent-run-id="${id}"]`)).toBeVisible();
      for (const id of failedIds)
        await expect(rail.locator(`a[href="/runs/${id}"]`)).toHaveCount(0);
      await page.getByTestId("rail-collapse-toggle").click();
      await rail
        .locator("summary")
        .filter({ has: page.getByTestId("rail-flyout-icon-agents") })
        .click();
      await expect(rail.locator("[data-agent-run-id]")).toHaveCount(6);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("mobile-rail-toggle").click();
      const drawer = page.getByTestId("mobile-rail-drawer");

      await expect(drawer.locator("[data-agent-run-id]")).toHaveCount(6);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(page.getByTestId("mobile-rail-toggle")).toBeFocused();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByTestId("rail-collapse-toggle").click();
      await withE2EDb((pool) =>
        pool.query(
          "UPDATE runs SET status='Abandoned',ended_at=now() WHERE id=$1",
          [activeIds[3]],
        ),
      );
      await expect(
        rail.locator(`[data-agent-run-id="${activeIds[3]}"]`),
      ).toHaveCount(0, { timeout: 20_000 });
      await expect(rail.locator("[data-agent-run-id]")).toHaveCount(5);
    });
    test(`E2E-UX-02 agent history pagination, URL state and detached read-only view (${locale})`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      const path = `/projects/${slug}/agents/${encodeURIComponent(agentId)}`;

      await page.goto(path);
      await expect(page.getByTestId("project-agent-page")).toBeVisible();
      await expect(
        page.getByTestId("agent-history-row").filter({ visible: true }),
      ).toHaveCount(25);
      await page
        .getByRole("link", {
          name: locale === "en" ? "Older records" : "Более ранние записи",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/cursor=/);
      await expect(
        page.getByTestId("agent-history-row").filter({ visible: true }),
      ).toHaveCount(1 + addedHistoryRuns);
      await page.reload();
      await expect(
        page.getByTestId("agent-history-row").filter({ visible: true }),
      ).toHaveCount(1 + addedHistoryRuns);
      if (locale === "en") {
        await withE2EDb((pool) =>
          pool.query(
            "INSERT INTO runs(id,project_id,run_kind,agent_id,agent_workspace,status,flow_version,source_agent_id,agent_activity_snapshot,launched_at,activity_sort_at,activity_timestamp_provenance,ended_at) SELECT $1,project_id,run_kind,agent_id,agent_workspace,'Done',flow_version,source_agent_id,agent_activity_snapshot,now(),now(),'launch',now() FROM runs WHERE id=$2",
            [randomUUID(), failedIds[0]],
          ),
        );
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: "New runs are available." }),
        ).toBeVisible({ timeout: 20000 });
        await expect(
          page.getByTestId("agent-history-row").filter({ visible: true }),
        ).toHaveCount(1);
        addedHistoryRuns++;
      }
      await page.goBack();
      await expect(
        page.getByTestId("agent-history-row").filter({ visible: true }),
      ).toHaveCount(25);
      await page.goto(`${path}?tab=definition`);
      await expect(
        page
          .getByText(
            locale === "en"
              ? "The pinned definition is unavailable. Execution history remains accessible."
              : "Закреплённое определение недоступно. Историю запусков можно просмотреть.",
            { exact: true },
          )
          .filter({ visible: true }),
      ).toBeVisible();
      await withE2EDb((pool) =>
        pool.query(
          "DELETE FROM agent_project_links WHERE project_id=$1 AND agent_id=$2",
          [projectId, agentId],
        ),
      );
      try {
        await page.goto(path);
        await expect(
          page
            .getByText(
              locale === "en"
                ? "This agent is detached or deleted. Retained history is available in read-only mode."
                : "Агент отключён или удалён. Сохранённая история доступна только для чтения.",
              { exact: true },
            )
            .filter({ visible: true }),
        ).toBeVisible();
        await expect(
          page.getByTestId("agent-history-row").filter({ visible: true }),
        ).toHaveCount(25);
        await expect(
          page.getByRole("button", {
            name: locale === "en" ? "Run again…" : "Запустить повторно…",
            exact: true,
          }),
        ).toHaveCount(0);
      } finally {
        await withE2EDb((pool) =>
          pool.query(
            "INSERT INTO agent_project_links(id,project_id,agent_id) VALUES ($1,$2,$3)",
            [randomUUID(), projectId, agentId],
          ),
        );
      }
    });
  }
  test("E2E-UX-01 grouped Inbox bounds repeated failures and acknowledges one cause", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await page.goto("/inbox");
    const card = page
      .getByTestId("agent-incident-card")
      .filter({ visible: true })
      .filter({
        has: page.locator(
          `a[href="/projects/${slug}/agents/${encodeURIComponent(agentId)}"]`,
        ),
      });

    await expect(card).toHaveCount(1);
    await card.locator("summary").click();
    await expect(card.getByTestId("agent-incident-cause")).toHaveCount(10);
    await card
      .getByRole("button", { name: "Next causes", exact: true })
      .click();
    await expect(card.getByTestId("agent-incident-cause")).toHaveCount(3);
    await card
      .getByRole("button", { name: "Acknowledge this cause", exact: true })
      .first()
      .click();
    await expect(card.getByTestId("agent-incident-cause")).toHaveCount(2);
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(
      card.getByText("12 causes need attention", { exact: true }),
    ).toBeVisible();
  });
  test("E2E-UX-03 failed runner stays in history and one Inbox group; one-off runner retry creates one Done successor", async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    const packageId = randomUUID();
    const operationId = `fixture-retry-${projectId.slice(0, 8)}:operation`;
    const bad = randomUUID();
    const good = randomUUID();
    const pkg = `fixture-retry-${projectId.slice(0, 8)}`;
    const root = `/tmp/${slug}/package`;

    await mkdir(`${root}/maister-agents`, { recursive: true });
    await writeFile(
      `${root}/maister-agents/operation.md`,
      "---\nname: Retry operation\ndescription: Controlled retry operation\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: none\nplatform_mcp: false\nrisk_tier: read_only\ntriggers: [manual]\n---\nComplete the controlled operation without source changes.",
    );
    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE runs SET status='Abandoned',ended_at=now() WHERE id=ANY($1::text[])",
        [activeIds],
      );
      await pool.query(
        "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,$2,$3,'v1',$4,$5,'fixture',$6,'Installed','trusted')",
        [
          packageId,
          root,
          pkg,
          "a".repeat(40),
          JSON.stringify({
            spec: {
              schemaVersion: 1,
              name: pkg,
              flows: [],
              compat: { engine_min: "3.10.0" },
            },
            inventory: {
              skills: [],
              agents: [],
              platformAgents: ["operation"],
            },
          }),
          root,
        ],
      );
      await pool.query(
        "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
        [randomUUID(), projectId, packageId, pkg],
      );
      await pool.query(
        "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,kind,completion_contract) VALUES($1,$2,'v1','git','Retry operation','Controlled retry','none','session','[\"manual\"]','read_only',$3,'operational','{\"contract\":\"operational_v1\"}')",
        [operationId, pkg, `${root}/maister-agents/operation.md`],
      );
      for (const [id, model] of [
        [bad, "e2e-prework-unavailable"],
        [good, "claude-sonnet-4-6"],
      ])
        await pool.query(
          "INSERT INTO platform_acp_runners(id,adapter,capability_agent,model,provider,permission_policy,readiness_status,readiness_reasons,enabled) VALUES($1,'claude','claude',$2,'{\"kind\":\"anthropic\"}','default','Ready','[]',true)",
          [id, model],
        );
      await pool.query(
        "INSERT INTO agent_project_links(id,project_id,agent_id,runner_override_id) VALUES($1,$2,$3,$4)",
        [randomUUID(), projectId, operationId, bad],
      );
    });
    try {
      const launch = await page.request.post(
        `/api/projects/${slug}/agents/${encodeURIComponent(operationId)}/launch`,
        { data: {} },
      );

      expect(launch.status()).toBe(202);
      const source = (await launch.json()) as { runId: string };

      let lastPreworkFacts = "{}";

      try {
        await expect
          .poll(
            async () => {
              const facts = await withE2EDb(
                async (pool) =>
                  (
                    await pool.query(
                      "SELECT r.status,r.execution_assignment_id,r.agent_config,r.operational_terminal,(SELECT jsonb_agg(jsonb_build_object('id',a.id,'epoch',a.epoch,'state',a.state,'placementReason',a.placement_reason)) FROM execution_assignments a WHERE a.run_id=r.id) AS assignments,(SELECT jsonb_agg(jsonb_build_object('phase',p.phase,'failure',p.failure,'leaseExpiresAt',p.lease_expires_at,'assignmentId',p.assignment_id,'assignmentEpoch',p.assignment_epoch)) FROM agent_preparation_operations p WHERE p.run_id=r.id) AS preparations,(SELECT jsonb_agg(jsonb_build_object('kind',c.kind,'state',c.state,'attempts',c.attempts,'errorCode',c.last_error->>'code','reason',coalesce(c.last_error->>'reason',c.last_error->'details'->>'reason'),'receiptPhase',c.receipt_evidence->>'phase','receiptInflight',c.receipt_evidence->'inflight','receiptHttpStatus',c.receipt_evidence->'httpStatus')) FROM execution_commands c WHERE c.run_id=r.id) AS commands,(SELECT jsonb_agg(jsonb_build_object('variant',t.variant,'state',t.state)) FROM agent_turns t WHERE t.run_id=r.id) AS turns,(SELECT jsonb_agg(jsonb_build_object('state',i.state,'assignmentEpoch',i.assignment_epoch)) FROM run_session_incarnations i WHERE i.run_id=r.id) AS incarnations FROM runs r WHERE r.id=$1",
                      [source.runId],
                    )
                  ).rows[0],
              );

              lastPreworkFacts = JSON.stringify(facts);

              return facts;
            },
            { timeout: 30000 },
          )
          .toMatchObject({ status: "Failed" });
      } finally {
        await test.info().attach("source-prework-facts", {
          body: lastPreworkFacts,
          contentType: "application/json",
        });
      }
      await page.goto(
        `/projects/${slug}/agents/${encodeURIComponent(operationId)}`,
      );
      await expect(
        page.getByTestId("agent-retry-history-toolbar"),
      ).toBeVisible();
      await page.goto(`/runs/${source.runId}`);
      const actions = page.getByTestId("agent-run-actions");
      const historyBounds = await actions
        .getByRole("link", { name: "History", exact: true })
        .boundingBox();
      const retryBounds = await actions
        .getByRole("button", { name: "Run again…", exact: true })
        .boundingBox();

      expect(historyBounds).not.toBeNull();
      expect(retryBounds).not.toBeNull();
      if (historyBounds && retryBounds && historyBounds.y === retryBounds.y) {
        expect(
          retryBounds.x - historyBounds.x - historyBounds.width,
        ).toBeGreaterThanOrEqual(8);
      }
      await page
        .getByRole("button", { name: "Run again…", exact: true })
        .filter({ visible: true })
        .click();
      const dialog = page.getByTestId("agent-retry-dialog");

      await expect(dialog).toContainText("Before operational work (verified)");
      await expect(
        dialog.getByLabel("Runner for this attempt", { exact: true }),
      ).toHaveValue(bad);
      await dialog
        .getByLabel("Runner for this attempt", { exact: true })
        .selectOption(good);
      await dialog
        .getByRole("button", { name: "Accept new attempt", exact: true })
        .click();
      await expect(dialog.getByTestId("agent-retry-receipt")).toBeVisible();
      await expect
        .poll(
          () =>
            withE2EDb(async (pool) =>
              JSON.stringify({
                runs: (
                  await pool.query(
                    "SELECT id,status,operational_terminal FROM runs WHERE retry_of_run_id=$1",
                    [source.runId],
                  )
                ).rows,
                intents: (
                  await pool.query(
                    "SELECT state,refusal_reason FROM agent_retry_intents WHERE source_run_id=$1",
                    [source.runId],
                  )
                ).rows,
              }),
            ),
          { timeout: 30000 },
        )
        .toMatch(/"status":"Done"/);
      await dialog
        .getByRole("button", { name: "Refresh current data", exact: true })
        .click();
      await dialog
        .getByRole("link", { name: "Open new attempt", exact: true })
        .click();
      await expect(
        page.getByTestId("operational-outcome").filter({ visible: true }),
      ).toHaveText("Done");
      const state = await withE2EDb(async (pool) => ({
        successors: (
          await pool.query(
            "SELECT count(*)::int amount FROM runs WHERE retry_of_run_id=$1",
            [source.runId],
          )
        ).rows[0].amount,
        runner: (
          await pool.query(
            "SELECT runner_override_id FROM agent_project_links WHERE project_id=$1 AND agent_id=$2",
            [projectId, operationId],
          )
        ).rows[0].runner_override_id,
      }));

      expect(state).toEqual({ successors: 1, runner: bad });

      const pendingSources: string[] = [];

      for (let index = 0; index < 2; index++) {
        const failedLaunch = await page.request.post(
          `/api/projects/${slug}/agents/${encodeURIComponent(operationId)}/launch`,
          { data: {} },
        );

        expect(failedLaunch.status()).toBe(202);
        pendingSources.push(
          ((await failedLaunch.json()) as { runId: string }).runId,
        );
      }
      await expect
        .poll(
          () =>
            withE2EDb(
              async (pool) =>
                (
                  await pool.query(
                    "SELECT count(*)::integer AS amount FROM runs WHERE id=ANY($1::text[]) AND status='Failed'",
                    [pendingSources],
                  )
                ).rows[0].amount,
            ),
          { timeout: 30000 },
        )
        .toBe(2);
      await page.goto(
        `/projects/${slug}/agents/${encodeURIComponent(operationId)}?tab=settings`,
      );
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const settingsDialog = page.getByRole("dialog");

      await expect(settingsDialog).toBeVisible();
      await settingsDialog
        .getByLabel("Runner override", { exact: true })
        .selectOption(good);
      await settingsDialog
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const batch = page.getByTestId("agent-retry-batch-dialog");

      await expect(batch).toBeVisible();
      await expect(
        batch.getByLabel("Runner for this batch", { exact: true }),
      ).toHaveValue(good);
      await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(
        2,
      );
      expect(
        await withE2EDb(
          async (pool) =>
            (
              await pool.query(
                "SELECT count(*)::integer AS amount FROM runs WHERE retry_of_run_id=ANY($1::text[])",
                [pendingSources],
              )
            ).rows[0].amount,
        ),
      ).toBe(0);
      await batch
        .getByRole("button", { name: "Start eligible work (2)", exact: true })
        .click();
      await expect
        .poll(
          () =>
            withE2EDb(
              async (pool) =>
                (
                  await pool.query(
                    "SELECT count(*)::integer AS amount FROM runs WHERE retry_of_run_id=ANY($1::text[]) AND status='Done'",
                    [pendingSources],
                  )
                ).rows[0].amount,
            ),
          { timeout: 30000 },
        )
        .toBe(2);
      await batch
        .getByRole("button", { name: "Refresh current data", exact: true })
        .click();
      await expect(
        batch.getByText("New attempt status: Done", { exact: true }),
      ).toHaveCount(2);
      expect(
        await withE2EDb(
          async (pool) =>
            (
              await pool.query(
                "SELECT runner_override_id FROM agent_project_links WHERE project_id=$1 AND agent_id=$2",
                [projectId, operationId],
              )
            ).rows[0].runner_override_id,
        ),
      ).toBe(good);
    } finally {
      await withE2EDb(async (pool) => {
        await pool.query(
          "UPDATE agent_project_links SET enabled=false WHERE project_id=$1 AND agent_id=$2",
          [projectId, operationId],
        );
        await pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
          operationId,
        ]);
        await pool.query(
          "UPDATE platform_acp_runners SET enabled=false WHERE id=ANY($1::text[])",
          [[bad, good]],
        );
      });
    }
  });

  test("E2E-UX-04 optional selector assessment preserves history and successful Triager automatically queues the selected Flow", async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await tickAutomaticLaunchScheduler(page);
    await withE2EDb((pool) =>
      pool.query(
        "UPDATE projects SET task_qualification_override='required' WHERE id=$1",
        [projectId],
      ),
    );
    const created = await page.request.post(`/api/projects/${slug}/tasks`, {
      data: {
        title: "Capture only current requests",
        prompt:
          "Original issue body: implement an explicit current behavior. Acceptance: preserve source and return a verified receipt.",
      },
    });

    expect(created.status()).toBe(201);
    const task = (await created.json()) as { taskId: string; number: number };

    // An unconfigured incoming request has no manual execution settings yet.
    await page.goto(`/projects/${slug}`);
    await expect(
      page
        .getByText("Capture only current requests", { exact: true })
        .filter({ visible: true }),
    ).toHaveCount(0);
    await page.goto(`/projects/${slug}?tab=incoming`);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(1);
    await page
      .getByTestId("incoming-request")
      .filter({ visible: true })
      .getByRole("link")
      .click();
    const panel = page
      .getByTestId("task-qualification")
      .filter({ visible: true });

    await expect(panel).toContainText("Not assessed");
    await panel.getByText("Record a human assessment", { exact: true }).click();
    const assessment = page.getByTestId("task-qualification-dialog");

    await assessment
      .getByRole("button", { name: "Save reviewed assessment", exact: true })
      .click();
    await expect(assessment).toContainText(
      "This assessment is optional. Manual Launch is a separate action and does not require this form.",
    );
    await expect(assessment.getByRole("alert")).toContainText(
      "Complete the highlighted field and explain your assessment.",
    );
    await expect(
      assessment.getByLabel("Evidence IDs, separated by commas", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(assessment.getByLabel(/Reason codes|commit SHA/i)).toHaveCount(
      0,
    );
    await assessment.getByLabel(/^Assessment decision/).selectOption("ready");
    await assessment.getByLabel(/^Task evidence/).selectOption(task.taskId);
    await assessment
      .getByRole("button", { name: "Add task evidence", exact: true })
      .click();
    await assessment
      .getByRole("button", { name: "Browse repository files", exact: true })
      .click();
    await assessment
      .getByRole("button", { name: "+ README.md", exact: true })
      .click();
    // Target each dimension fieldset; the outer disabled fieldset is excluded by legend.
    const dimensions = [
      "Goal and scope",
      "Acceptance criteria",
      "Internal consistency",
      "Constraints and dependencies",
      "Strong duplicates",
      "Current relevance",
      "Bug evidence",
    ];

    for (const dimension of dimensions) {
      const check = assessment.getByRole("group", {
        name: dimension,
        exact: true,
      });

      await check
        .getByLabel(/^Check result/)
        .selectOption(dimension === "Bug evidence" ? "not_applicable" : "pass");
      await check
        .getByLabel("Rationale", { exact: true })
        .fill(
          dimension === "Bug evidence"
            ? "Feature request; bug reproduction is not applicable."
            : "Reviewed the precise request against README.md at the checked repository target.",
        );
      if (dimension !== "Bug evidence") {
        await check
          .getByRole("checkbox", { name: "README.md", exact: true })
          .check();
        await check
          .getByRole("checkbox", { name: /Capture only current requests/ })
          .check();
      }
    }
    await assessment
      .getByRole("button", { name: "Save reviewed assessment", exact: true })
      .click();
    await expect(
      panel.getByText("Assessment saved.", { exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText("Ready for accepted backlog");
    await panel
      .getByText("Complete structured assessment", { exact: true })
      .click();
    await expect(panel.locator("pre")).toContainText('"id": "evidence-1"');
    await expect(panel.locator("pre")).toContainText('"id": "evidence-2"');
    await expect(panel.locator("pre")).toContainText("README.md");
    const manualAssessment = await withE2EDb(async (pool) => ({
      assessments: (
        await pool.query(
          "SELECT author_kind,publication_state FROM task_qualifications WHERE task_id=$1",
          [task.taskId],
        )
      ).rows,
      runs: (
        await pool.query("SELECT id FROM runs WHERE task_id=$1", [task.taskId])
      ).rows,
      intents: (
        await pool.query(
          "SELECT id FROM task_launch_intents WHERE task_id=$1",
          [task.taskId],
        )
      ).rows,
    }));

    expect(manualAssessment).toEqual({
      assessments: [{ author_kind: "user", publication_state: "accepted" }],
      runs: [],
      intents: [],
    });
    await page.goto(`/projects/${slug}?tab=incoming`);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(0);
    await page.goto(`/projects/${slug}`);
    await expect(
      page
        .getByText("Capture only current requests", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    const options = await page.request.get(
      `/api/runs/launch-options?taskId=${task.taskId}`,
    );

    expect(options.status()).toBe(200);
    const currentInput = (await options.json()) as {
      task: { revision: number };
    };
    const edited = await page.request.patch(
      `/api/projects/${slug}/tasks/${task.number}`,
      {
        data: {
          expectedRevision: currentInput.task.revision,
          prompt:
            "Original issue body: implement an explicit current behavior. Acceptance: preserve source and return a verified receipt. New constraint requiring reassessment.",
        },
      },
    );

    expect(edited.status()).toBe(200);
    await page.goto(`/projects/${slug}?tab=incoming`);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(1);
    await page
      .getByTestId("incoming-request")
      .filter({ visible: true })
      .getByRole("link")
      .click();
    await expect(
      page.getByTestId("task-qualification").filter({ visible: true }),
    ).toContainText("Assessment is stale");
    const stalePanel = page
      .getByTestId("task-qualification")
      .filter({ visible: true });

    await stalePanel
      .getByRole("button", { name: "View assessment evidence", exact: true })
      .click();
    await expect(stalePanel).toContainText("Accepted assessment");
    await stalePanel
      .getByText("Complete structured assessment", { exact: true })
      .click();
    await expect(stalePanel.locator("pre")).toContainText('"id": "evidence-2"');
    await withE2EDb((pool) =>
      pool.query(
        "UPDATE runs SET status='Abandoned',ended_at=now() WHERE id=ANY($1::text[])",
        [activeIds],
      ),
    );
    const qualifierPackage = randomUUID();
    const qualifierId = `fixture-qualifier-${projectId.slice(0, 8)}:triager`;
    const qualifierName = qualifierId.split(":")[0];
    const root = `/tmp/${slug}/qualifier`;
    const deliveryFlowId = randomUUID();
    const deliveryRevisionId = randomUUID();
    const deliveryRoot = `/tmp/${slug}/delivery`;
    const deliveryManifest = {
      schemaVersion: 1,
      name: "Selected delivery fixture",
      nodes: [
        {
          id: "check",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    };

    await mkdir(deliveryRoot, { recursive: true });
    await cp("test-support/fixtures/operational-core", root, {
      recursive: true,
    });
    const runner = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT id FROM platform_acp_runners WHERE enabled=true AND readiness_status='Ready' AND adapter='claude' ORDER BY id LIMIT 1",
          )
        ).rows[0].id as string,
    );

    await withE2EDb(async (pool) => {
      // Seed only new fixture catalog entries; task settings and automation are
      // selected below through their authenticated HTTP control-plane APIs.
      await pool.query(
        "INSERT INTO flow_revisions(id,flow_ref_id,source,version_label,resolved_revision,manifest_digest,manifest,schema_version,installed_path,setup_status,package_status,exec_trust) VALUES($1,$2,'fixture','v1',$3,$4,$5,1,$6,'not_required','Installed','trusted')",
        [
          deliveryRevisionId,
          deliveryFlowId,
          "c".repeat(40),
          "c".repeat(64),
          JSON.stringify(deliveryManifest),
          deliveryRoot,
        ],
      );
      await pool.query(
        "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version,enabled_revision_id,enablement_state,trust_status) VALUES($1,$2,$1,'fixture','v1',$3,$4,1,$5,'Enabled','trusted')",
        [
          deliveryFlowId,
          projectId,
          deliveryRoot,
          JSON.stringify(deliveryManifest),
          deliveryRevisionId,
        ],
      );
      await pool.query(
        "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,$2,$3,'v1',$4,$5,'fixture',$2,'Installed','trusted')",
        [
          qualifierPackage,
          root,
          qualifierName,
          "b".repeat(40),
          JSON.stringify({
            spec: {
              schemaVersion: 1,
              name: qualifierName,
              flows: [],
              capabilities: [{ id: "core-bundle", path: "capability" }],
              compat: { engine_min: "3.10.0" },
            },
            inventory: {
              skills: ["task-qualification", "github-issue-intake"],
              agents: [],
              platformAgents: ["triager"],
            },
          }),
        ],
      );
      await pool.query(
        "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
        [randomUUID(), projectId, qualifierPackage, qualifierName],
      );
      await pool.query(
        "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,workspace_ref,mode,triggers,risk_tier,source_path,kind,completion_contract,task_qualification) VALUES($1,$2,'v1','git','Qualifier','Controlled core qualifier','repo_read','task_target','session','[\"manual\"]','read_only',$3,'operational','{\"contract\":\"operational_v1\"}','{\"contract\":\"v1\",\"role\":\"qualifier\"}')",
        [qualifierId, qualifierName, `${root}/maister-agents/triager.md`],
      );
      await pool.query(
        "INSERT INTO agent_project_links(id,project_id,agent_id,runner_override_id) VALUES($1,$2,$3,$4)",
        [randomUUID(), projectId, qualifierId, runner],
      );
    });
    const configured = await page.request.patch(
      `/api/projects/${slug}/tasks/${task.number}`,
      {
        data: { flowId: deliveryFlowId, runnerId: runner },
      },
    );

    expect(configured.status()).toBe(200);
    const automation = await page.request.patch(
      `/api/projects/${slug}/agents/${encodeURIComponent(qualifierId)}`,
      {
        data: { configValues: { auto_enqueue: "always" } },
      },
    );

    expect(automation.status()).toBe(200);
    await page.goto(`/projects/${slug}`);
    // Configured manual work stays visible even while its assessment is stale.
    await expect(
      page
        .getByText("Capture only current requests", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await page.goto(`/projects/${slug}/tasks/${task.number}`);
    await expect(
      page.getByTestId("task-qualification").filter({ visible: true }),
    ).toContainText("Assessment is stale");
    expect(
      await withE2EDb(
        async (pool) =>
          (
            await pool.query(
              "SELECT id FROM task_launch_intents WHERE task_id=$1",
              [task.taskId],
            )
          ).rows,
      ),
    ).toEqual([]);
    const launch = await page.request.post(
      `/api/projects/${slug}/agents/${encodeURIComponent(qualifierId)}/launch`,
      { data: { taskId: task.taskId } },
    );

    expect(launch.status()).toBe(202);
    const qualifier = (await launch.json()) as { runId: string };

    await expect
      .poll(
        () =>
          withE2EDb(async (pool) => {
            const state = (
              await pool.query(
                "SELECT r.status,r.operational_terminal,(SELECT jsonb_agg(jsonb_build_object('kind',kind,'payload',payload)) FROM domain_events WHERE run_id=r.id) AS evidence,(SELECT count(*)::int FROM task_qualifications q WHERE q.author_run_id=r.id AND q.publication_state='candidate') AS candidates FROM runs r WHERE r.id=$1",
                [qualifier.runId],
              )
            ).rows[0];

            if (state.status === "Failed")
              throw new Error(
                `Controlled qualifier failed: ${JSON.stringify(state)}`,
              );

            return state;
          }),
        { timeout: 15000 },
      )
      .toMatchObject({ status: "Running", candidates: 1 });
    const sessionRecords = await Promise.all(
      (await readdir(STUB_SESSIONS_DIR))
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(`${STUB_SESSIONS_DIR}/${name}`, "utf8"),
            ) as {
              request: {
                runId: string;
                agentKind?: string;
                readOnlySession?: boolean;
                autoApprovePermissions?: boolean;
              };
            },
        ),
    );
    const qualifierSession = sessionRecords.find(
      (record) => record.request.runId === qualifier.runId,
    );

    expect(qualifierSession?.request).toMatchObject({
      agentKind: "operational",
      readOnlySession: true,
    });
    expect(qualifierSession?.request.autoApprovePermissions).not.toBe(true);
    const held = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT current_qualification_id,launch_mode FROM tasks WHERE id=$1",
            [task.taskId],
          )
        ).rows[0],
    );

    expect(held).toMatchObject({ current_qualification_id: null });
    expect(held.launch_mode).not.toBe("auto");
    expect(
      await withE2EDb(
        async (pool) =>
          (
            await pool.query(
              "SELECT id FROM task_launch_intents WHERE task_id=$1",
              [task.taskId],
            )
          ).rows,
      ),
    ).toEqual([]);
    await page.reload();
    await expect(
      page.getByTestId("task-qualification").filter({ visible: true }),
    ).toContainText("Agent assessment pending validated run completion");
    await writeFile(
      `${STUB_SESSIONS_DIR}/${qualifier.runId}.qualification-release`,
      "release",
    );
    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (
                await pool.query(
                  "SELECT status,operational_terminal FROM runs WHERE id=$1",
                  [qualifier.runId],
                )
              ).rows[0],
          ),
        { timeout: 15000 },
      )
      .toMatchObject({
        status: "Done",
        operational_terminal: {
          successful: true,
          validation: "valid",
          integrity: "clean",
        },
      });
    const published = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT q.publication_state,q.value->>'decision' AS decision,q.evidence_sha,r.task_qualification_snapshot->>'sha' AS pinned_sha FROM task_qualifications q JOIN runs r ON r.id=q.author_run_id WHERE q.author_run_id=$1",
            [qualifier.runId],
          )
        ).rows,
    );

    expect(published).toEqual([
      {
        publication_state: "accepted",
        decision: "ready",
        evidence_sha: expect.any(String),
        pinned_sha: expect.any(String),
      },
    ]);
    expect(published[0].evidence_sha).toBe(published[0].pinned_sha);
    const automaticIntent = () =>
      withE2EDb(
        async (pool) =>
          (
            await pool.query<{
              basis: string;
              flow_id: string;
              flow_revision_id: string;
            }>(
              "SELECT basis->>'kind' AS basis,settings_snapshot->>'flowId' AS flow_id,settings_snapshot->>'flowRevisionId' AS flow_revision_id FROM task_launch_intents WHERE task_id=$1",
              [task.taskId],
            )
          ).rows,
      );
    const selectedAutomaticIntent = [
      {
        basis: "automatic",
        flow_id: deliveryFlowId,
        flow_revision_id: deliveryRevisionId,
      },
    ];

    // Timers are disabled: clean publication must wake automatic admission.
    await expect
      .poll(automaticIntent, { timeout: 15000 })
      .toEqual(selectedAutomaticIntent);
    // Timers are disabled in this harness. Drive the real token-authorized
    // scheduler twice; rearming through the admin API never edits run evidence.
    for (let attempt = 0; attempt < 2; attempt++) {
      const due = await page.request.patch(
        "/api/admin/scheduler-jobs/auto_launch_triaged.default",
        {
          data: { nextRunAt: new Date(0).toISOString(), enabled: true },
        },
      );

      expect(due.status(), await due.text()).toBe(200);
      await tickAutomaticLaunchScheduler(page);
    }
    await expect
      .poll(automaticIntent, { timeout: 15000 })
      .toEqual(selectedAutomaticIntent);
    await page.goto(`/projects/${slug}?tab=incoming`);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(0);
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: baseURL! },
    ]);
    await page.goto(`/projects/${slug}/tasks/${task.number}`);
    const ruPanel = page
      .getByTestId("task-qualification")
      .filter({ visible: true });

    await expect(ruPanel).toContainText("Допущено в бэклог");
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO tasks(id,project_id,number,title,prompt,status,qualification_mode) SELECT gen_random_uuid()::text,$1,1000+n,'Held pagination request '||n,'Specific request awaiting its seven checks','Backlog','required' FROM generate_series(1,26) n",
        [projectId],
      ),
    );
    await page.goto(`/projects/${slug}?tab=incoming&incoming_state=unassessed`);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(25);
    const older = page
      .locator('a[href*="page=2"][href*="tab=incoming"]')
      .filter({ visible: true });

    await expect(older).toHaveAttribute("href", /incoming_state=unassessed/);
    await older.click();
    await expect(page).toHaveURL(/incoming_state=unassessed/);
    await expect(
      page.getByTestId("incoming-request").filter({ visible: true }),
    ).toHaveCount(1);

    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE agent_project_links SET enabled=false WHERE project_id=$1 AND agent_id=$2",
        [projectId, qualifierId],
      );
    });
  });
});

async function tickAutomaticLaunchScheduler(page: Page): Promise<void> {
  const tick = await page.request.post(
    "/api/cron/tick?jobKind=auto_launch_triaged",
    {
      headers: {
        Authorization: `Bearer ${process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me"}`,
      },
    },
  );

  expect(tick.ok(), await tick.text()).toBe(true);
}
