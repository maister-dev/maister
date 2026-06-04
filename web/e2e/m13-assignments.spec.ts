import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { test, expect } from "@playwright/test";

import { E2E_DB_URL } from "./_seed/db-url";
import { loadFixtures } from "./_seed/fixtures";

const PROJECT_SLUG = "e2e-m13-assignments";
const BRANCH = "maister/e2e-assignments";

const REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

const FLOW_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Assignments (e2e)",
  compat: { engine_min: "1.3.0" },
  nodes: [
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework"],
        },
      },
      transitions: { approve: "done", rework: "implement" },
    },
  ],
};

type SeededAssignmentFixture = {
  assignmentId: string;
  runId: string;
};

async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: E2E_DB_URL });

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function seedAssignmentFixture(): Promise<SeededAssignmentFixture> {
  const fixtures = loadFixtures();
  const admin = fixtures.users.admin;
  const editTarget = fixtures.users.editTarget;
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
    role: randomUUID(),
    adminActor: randomUUID(),
    previousActor: randomUUID(),
    assignment: randomUUID(),
    createdEvent: randomUUID(),
    claimedEvent: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-assignments`;

  await withDb(async (pool) => {
    await pool.query(`DELETE FROM projects WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.query(
      `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.project,
        PROJECT_SLUG,
        "MAIster E2E Assignments",
        repoPath,
        `${repoPath}/maister.yaml`,
      ],
    );
    await pool.query(
      `INSERT INTO project_flow_roles (id, project_id, role_ref, label)
       VALUES ($1, $2, 'maintainer', 'Maintainer')`,
      [ids.role, ids.project],
    );
    await pool.query(
      `INSERT INTO platform_acp_runners
         (id, adapter, capability_agent, model, provider, permission_policy,
          readiness_status, readiness_reasons, enabled)
       VALUES ($1, 'claude', 'claude', 'claude-sonnet-4-6',
          '{"kind":"anthropic"}'::jsonb, 'default', 'Ready', '[]'::jsonb, true)
       ON CONFLICT (id) DO NOTHING`,
      [ids.runner],
    );
    await pool.query(
      `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
       VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
      [
        ids.flow,
        ids.project,
        "github.com/maister/maister-flow-aif",
        `/tmp/maister-e2e/flows/aif-m13@v0.0.1`,
        JSON.stringify(FLOW_MANIFEST),
      ],
    );
    await pool.query(
      `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
      [
        ids.task,
        ids.project,
        "E2E assignment queue",
        "review the work",
        ids.flow,
      ],
    );
    await pool.query(
      `INSERT INTO runs
         (id, task_id, project_id, flow_id, runner_id, capability_agent,
          runner_snapshot, status, current_step_id, flow_version, started_at)
       VALUES ($1, $2, $3, $4, $5, 'claude',
          jsonb_build_object(
            'id', $5,
            'adapter', 'claude',
            'capabilityAgent', 'claude',
            'model', 'claude-sonnet-4-6',
            'provider', jsonb_build_object('kind', 'anthropic'),
            'providerKind', 'anthropic',
            'permissionPolicy', 'default',
            'sidecar', null,
            'sidecarId', null
          ),
          'NeedsInput', 'review', 'v0.0.1', now())`,
      [ids.run, ids.task, ids.project, ids.flow, ids.runner],
    );
    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ids.workspace, ids.run, ids.project, BRANCH, worktreePath, repoPath],
    );
    await pool.query(
      `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
       VALUES ($1, $2, 'review', 'human', $3, $4)`,
      [
        ids.hitl,
        ids.run,
        JSON.stringify(REVIEW_SCHEMA),
        "Review the implementation assignment.",
      ],
    );
    await pool.query(
      `INSERT INTO project_members (id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [ids.member, ids.project, admin.id],
    );
    await pool.query(
      `INSERT INTO actor_identities (id, project_id, kind, label, user_id)
       VALUES ($1, $2, 'user', $3, $4), ($5, $2, 'user', $6, $7)`,
      [
        ids.adminActor,
        ids.project,
        admin.name,
        admin.id,
        ids.previousActor,
        editTarget.name,
        editTarget.id,
      ],
    );
    await pool.query(
      `INSERT INTO assignments
         (id, project_id, run_id, task_id, step_id, hitl_request_id, action_kind, status, role_refs, title, assignee_actor_id, created_by_actor_id, branch, claimed_at)
       VALUES ($1, $2, $3, $4, 'review', $5, 'human_review', 'claimed', $6, $7, $8, $8, $9, now())`,
      [
        ids.assignment,
        ids.project,
        ids.run,
        ids.task,
        ids.hitl,
        JSON.stringify(["maintainer"]),
        "Review assignment",
        ids.previousActor,
        BRANCH,
      ],
    );
    await pool.query(
      `INSERT INTO assignment_events
         (id, assignment_id, project_id, run_id, event_kind, actor_id, from_status, to_status, payload)
       VALUES
         ($1, $2, $3, $4, 'created', $5, NULL, 'open', $6),
         ($7, $2, $3, $4, 'claimed', $5, 'open', 'claimed', $6)`,
      [
        ids.createdEvent,
        ids.assignment,
        ids.project,
        ids.run,
        ids.previousActor,
        JSON.stringify({ source: "e2e" }),
        ids.claimedEvent,
      ],
    );
  });

  return { assignmentId: ids.assignment, runId: ids.run };
}

test("assignment queue actions: take over → release → claim stay consistent across inbox and run detail", async ({
  page,
}) => {
  const fx = await seedAssignmentFixture();

  await page.goto(`/projects/${PROJECT_SLUG}`);

  await expect(page.getByRole("heading", { name: "HITL inbox" })).toBeVisible();
  await expect(page.getByText("claimed by E2E Edit Target")).toBeVisible();

  const takeOverResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/assignments/${fx.assignmentId}/take-over`) &&
      r.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Take over", exact: true }).click();
  expect((await takeOverResponse).status()).toBe(200);
  await expect(page.getByText("claimed by E2E Admin")).toBeVisible();

  const releaseResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/assignments/${fx.assignmentId}/release`) &&
      r.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Release", exact: true }).click();
  expect((await releaseResponse).status()).toBe(200);
  await expect(page.getByText("unclaimed").first()).toBeVisible();

  const claimResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/assignments/${fx.assignmentId}/claim`) &&
      r.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Claim", exact: true }).click();
  expect((await claimResponse).status()).toBe(200);
  await expect(page.getByText("claimed by E2E Admin")).toBeVisible();

  await page.goto(`/runs/${fx.runId}`);
  await expect(page.getByText("claimed by E2E Admin")).toBeVisible();
  await expect(page.getByRole("button", { name: "Release" })).toBeVisible();
  await expect(page.getByText("roles: maintainer")).toBeVisible();
});
