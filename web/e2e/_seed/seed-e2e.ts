/* eslint-disable no-console */
// Standalone e2e fixture seeder. Deliberately uses raw `pg` SQL and avoids
// importing `@/lib/db/schema` (and anything `server-only`) so it runs in the
// plain tsx/Playwright context without the register shim. Invoked by
// e2e/global-setup.ts against the DEDICATED e2e database (never the dev DB).
//
// It plants ONE fixture PER authed spec, each on its OWN project/run/worktree
// (distinct ids + a `.worktrees/<slug>` path) so the `fullyParallel` authed
// specs claim/return against their own run and never race a shared fixture:
//
//   • `e2e-m11a` — a run parked in `NeedsInput` with a graph `human` review
//     HITL whose schema declares the approve/rework allow-list. The M11a
//     review→rework spec drives this; it never resumes the runner, so it needs
//     no real worktree.
//   • `e2e-m11b` — a GRAPH run paused at the `aif` `review` (human_review) node
//     offering the `takeover` decision: a REAL on-disk git worktree (parent
//     repo `git init` + base commit + `git worktree add` the run branch), real
//     `node_attempts` history (implement Succeeded → checks Succeeded + a PASSED
//     command_check gate → review NeedsInput) and a pending `human_review` HITL
//     whose schema includes `takeover`. The M11b takeover spec claims, commits
//     in the worktree, returns through the UI, and asserts the staled re-entry
//     gate reruns to a fresh review — so the return route's
//     resolveBaseRef/logRange/diffRange operate on real git state.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import bcrypt from "bcryptjs";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = "e2e-admin@maister.local";
const ADMIN_PASSWORD = "E2eReview!pass1";

// --- M11a fixture: parked review→rework (no worktree, never resumes) --------

const M11A_SLUG = "e2e-m11a";
const M11A_BRANCH = "maister/e2e-review-rework";

const M11A_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

const M11A_MANIFEST = {
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

// --- M11b fixture: graph run paused at a takeover-capable review node --------

const M11B_SLUG = "e2e-m11b";
const M11B_BRANCH = "maister/e2e-takeover";
const M11B_REENTRY_NODE = "checks";
const M11B_REVIEW_NODE = "review";

// implement (ai_coding, never re-run on resume) -> checks (check with a passing
// command_check gate) -> review (human; takeover -> checks). The `checks` and
// its gate run local commands only (`true`), so the return-route resume drives
// to a fresh review HITL with NO supervisor — supervisor-independent, the same
// shape the takeover-resume integration test pins.
const M11B_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Takeover (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/impl" },
      transitions: { success: M11B_REENTRY_NODE },
    },
    {
      id: M11B_REENTRY_NODE,
      type: "check",
      action: { command: "true" },
      pre_finish: {
        gates: [
          {
            id: "lint",
            kind: "command_check",
            mode: "blocking",
            command: "true",
          },
        ],
      },
      transitions: { success: M11B_REVIEW_NODE },
    },
    {
      id: M11B_REVIEW_NODE,
      type: "human",
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework", "takeover"],
        },
      },
      transitions: {
        approve: "done",
        rework: "implement",
        takeover: M11B_REENTRY_NODE,
      },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
};

const M11B_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework", "takeover"],
  transitions: {
    approve: "done",
    rework: "implement",
    takeover: M11B_REENTRY_NODE,
  },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

type FixtureRecord = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  worktreePath: string;
};

async function provisionWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", repoPath]);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "config",
    "user.email",
    "e2e@maister.local",
  ]);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "config",
    "user.name",
    "MAIster E2E",
  ]);
  writeFileSync(path.join(repoPath, "README.md"), "base\n");
  await execFileAsync("git", ["-C", repoPath, "add", "."]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "base"]);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);
}

async function seedM11aFixture(
  pool: Pool,
  userId: string,
): Promise<FixtureRecord> {
  const ids = {
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
  const worktreePath = `${repoPath}/.worktrees/e2e-review`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M11A_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      ids.project,
      M11A_SLUG,
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
      JSON.stringify(M11A_MANIFEST),
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
    [ids.workspace, ids.run, ids.project, M11A_BRANCH, worktreePath, repoPath],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(M11A_REVIEW_SCHEMA),
      "Review the implementation. Approve to ship, or request rework.",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  return {
    runId: ids.run,
    hitlRequestId: ids.hitl,
    projectSlug: M11A_SLUG,
    branch: M11A_BRANCH,
    worktreePath,
  };
}

async function seedM11bFixture(
  pool: Pool,
  userId: string,
): Promise<FixtureRecord> {
  const ids = {
    project: randomUUID(),
    executor: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
    implAttempt: randomUUID(),
    checksAttempt: randomUUID(),
    reviewAttempt: randomUUID(),
    gate: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-takeover`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M11B_SLUG]);

  // Real on-disk git: parent repo + base commit + a worktree on the run branch,
  // so resolveBaseRef (merge-base main..branch) and logRange/diffRange resolve.
  mkdirSync(path.dirname(repoPath), { recursive: true });
  await provisionWorktree(repoPath, worktreePath, M11B_BRANCH);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path)
     VALUES ($1, $2, $3, $4, 'main', $5)`,
    [
      ids.project,
      M11B_SLUG,
      "MAIster E2E Takeover",
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
      `/tmp/maister-e2e/flows/aif-takeover@v0.0.1`,
      JSON.stringify(M11B_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E manual takeover", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, executor_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, $5, 'NeedsInput', $6, 'v0.0.1', now())`,
    [ids.run, ids.task, ids.project, ids.flow, ids.executor, M11B_REVIEW_NODE],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ids.workspace, ids.run, ids.project, M11B_BRANCH, worktreePath, repoPath],
  );

  // Ledger history: implement Succeeded → checks Succeeded (+ PASSED gate) →
  // review NeedsInput. The passed `lint` gate is the one that MUST flip stale on
  // return and rerun. No owner row yet — the spec claims through the UI.
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.implAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, $3, 'check', 1, 'Succeeded', now())`,
    [ids.checksAttempt, ids.run, M11B_REENTRY_NODE],
  );
  await pool.query(
    `INSERT INTO gate_results (id, run_id, node_attempt_id, gate_id, kind, mode, status, ended_at)
     VALUES ($1, $2, $3, 'lint', 'command_check', 'blocking', 'passed', now())`,
    [ids.gate, ids.run, ids.checksAttempt],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status)
     VALUES ($1, $2, $3, 'human', 1, 'NeedsInput')`,
    [ids.reviewAttempt, ids.run, M11B_REVIEW_NODE],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, $3, 'human', $4, $5)`,
    [
      ids.hitl,
      ids.run,
      M11B_REVIEW_NODE,
      JSON.stringify(M11B_REVIEW_SCHEMA),
      "Review the implementation. Approve, request rework, or take over locally.",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  return {
    runId: ids.run,
    hitlRequestId: ids.hitl,
    projectSlug: M11B_SLUG,
    branch: M11B_BRANCH,
    worktreePath,
  };
}

async function main(): Promise<void> {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    console.error(`seed-e2e: DB_URL must be a Postgres URL, got: ${url}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });

  try {
    const userId = randomUUID();

    await pool.query(`DELETE FROM users WHERE email = $1`, [ADMIN_EMAIL]);
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, account_status, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', 'active', false)`,
      [userId, "E2E Admin", ADMIN_EMAIL, passwordHash],
    );

    const m11a = await seedM11aFixture(pool, userId);
    const m11b = await seedM11bFixture(pool, userId);

    // fixtures.json: shared admin creds + a per-spec record under `byKey`. The
    // top-level run/hitl/branch fields preserve the M11a spec's existing reads.
    const fixtures = {
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      runId: m11a.runId,
      hitlRequestId: m11a.hitlRequestId,
      projectSlug: m11a.projectSlug,
      branch: m11a.branch,
      byKey: {
        m11a,
        m11b,
      },
    };
    const outDir = path.resolve("e2e/.auth");

    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "fixtures.json"),
      `${JSON.stringify(fixtures, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `seed-e2e: seeded m11a run ${m11a.runId} (${M11A_SLUG}) + m11b run ${m11b.runId} (${M11B_SLUG})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-e2e failed:", err);
  process.exit(1);
});
