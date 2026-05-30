/* eslint-disable no-console */
// Standalone e2e fixture seeder. Deliberately uses raw `pg` SQL and avoids
// importing `@/lib/db/schema` (and anything `server-only`) so it runs in the
// plain tsx/Playwright context without the register shim. Invoked by
// e2e/global-setup.ts against the DEDICATED e2e database (never the dev DB).
//
// It plants exactly one fixture: an `e2e-m11a` project with a run parked in
// `NeedsInput` and a graph `human` review HITL whose schema declares the
// approve/rework allow-list — the state the M11a review→rework spec drives.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import bcrypt from "bcryptjs";
import { Pool } from "pg";

const PROJECT_SLUG = "e2e-m11a";
const ADMIN_EMAIL = "e2e-admin@maister.local";
const ADMIN_PASSWORD = "E2eReview!pass1";
const BRANCH = "maister/e2e-review-rework";

const REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

const MANIFEST = {
  schemaVersion: 1,
  name: "AIF (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      prompt: "implement {{ task.prompt }}",
    },
    {
      id: "review",
      type: "human",
      decisions: ["approve", "rework"],
      transitions: { approve: "done", rework: "implement" },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
};

async function main(): Promise<void> {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    console.error(`seed-e2e: DB_URL must be a Postgres URL, got: ${url}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    executor: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;

  try {
    // Idempotent: dropping the project cascades executors/flows/tasks/runs/
    // workspaces/hitl/members; the user row is cleared separately.
    await pool.query(`DELETE FROM projects WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.query(`DELETE FROM users WHERE email = $1`, [ADMIN_EMAIL]);

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, account_status, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', 'active', false)`,
      [ids.user, "E2E Admin", ADMIN_EMAIL, passwordHash],
    );

    await pool.query(
      `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.project,
        PROJECT_SLUG,
        "MAIster E2E",
        repoPath,
        `${repoPath}/maister.yaml`,
      ],
    );

    await pool.query(
      `INSERT INTO executors (id, project_id, executor_ref_id, agent, model)
       VALUES ($1, $2, 'claude-sonnet', 'claude', 'claude-sonnet-4-6')`,
      [ids.executor, ids.project],
    );

    await pool.query(
      `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
       VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
      [
        ids.flow,
        ids.project,
        "github.com/maister/maister-flow-aif",
        `/tmp/maister-e2e/flows/aif@v0.0.1`,
        JSON.stringify(MANIFEST),
      ],
    );

    await pool.query(
      `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
      [ids.task, ids.project, "E2E review→rework", "do the thing", ids.flow],
    );

    await pool.query(
      `INSERT INTO runs (id, task_id, project_id, flow_id, executor_id, status, current_step_id, flow_version)
       VALUES ($1, $2, $3, $4, $5, 'NeedsInput', 'review', 'v0.0.1')`,
      [ids.run, ids.task, ids.project, ids.flow, ids.executor],
    );

    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ids.workspace,
        ids.run,
        ids.project,
        BRANCH,
        `${repoPath}/.worktrees/e2e-review`,
        repoPath,
      ],
    );

    await pool.query(
      `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
       VALUES ($1, $2, 'review', 'human', $3, $4)`,
      [
        ids.hitl,
        ids.run,
        JSON.stringify(REVIEW_SCHEMA),
        "Review the implementation. Approve to ship, or request rework.",
      ],
    );

    await pool.query(
      `INSERT INTO project_members (id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [ids.member, ids.project, ids.user],
    );

    const fixtures = {
      runId: ids.run,
      hitlRequestId: ids.hitl,
      projectSlug: PROJECT_SLUG,
      branch: BRANCH,
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
    };
    const outDir = path.resolve("e2e/.auth");

    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "fixtures.json"),
      `${JSON.stringify(fixtures, null, 2)}\n`,
      "utf8",
    );
    console.log(`seed-e2e: seeded run ${ids.run} (project ${PROJECT_SLUG})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-e2e failed:", err);
  process.exit(1);
});
