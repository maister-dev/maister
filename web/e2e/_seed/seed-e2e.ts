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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import bcrypt from "bcryptjs";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = "e2e-admin@maister.local";
const ADMIN_PASSWORD = "E2eReview!pass1";
const MUST_CHANGE_EMAIL = "e2e-must-change@maister.local";
const MUST_CHANGE_PASSWORD = "E2eMustChange!pass1";
const PENDING_EMAIL = "e2e-pending@maister.local";
const PENDING_PASSWORD = "E2ePending!pass1";
const DISABLED_EMAIL = "e2e-disabled@maister.local";
const DISABLED_PASSWORD = "E2eDisabled!pass1";
const MEMBER_EMAIL = "e2e-member@maister.local";
const MEMBER_PASSWORD = "E2eMember!pass1";
const EDIT_TARGET_EMAIL = "e2e-edit-target@maister.local";
const EDIT_TARGET_PASSWORD = "E2eEditTarget!pass1";

const BOARD_SLUG = "e2e-acceptance-board";
const SCRATCH_SLUG = "e2e-acceptance-scratch";
const REGISTRATION_SLUG = "e2e-registerable";
const REGISTRATION_DUP_SLUG = "e2e-registerable-dup";
const LIVE_CCR_SLUG = "e2e-live-ccr";

const RUNTIME_ROOT = "/tmp/maister-e2e";

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

// The M11c refusal fixture has no run yet (the whole point is that launching it
// is refused before a run exists), so it carries the task id and the node/class
// the refusal message must name instead of a runId.
type RefuseFixtureRecord = {
  projectSlug: string;
  taskId: string;
  nodeId: string;
  refusedClass: string;
};

type UserFixture = {
  id: string;
  email: string;
  password: string;
  name: string;
};

type ProjectFixture = {
  projectId: string;
  projectSlug: string;
  repoPath: string;
  executorId: string;
  flowId: string;
  taskId?: string;
  runId?: string;
  hitlRequestId?: string;
  worktreePath?: string;
  branch?: string;
};

type RegistrationFixture = {
  repoPath: string;
  duplicateRepoPath: string;
  expectedSlug: string;
  duplicateSlug: string;
};

const LINEAR_MANIFEST = {
  schemaVersion: 1,
  name: "Acceptance Flow",
  steps: [
    {
      id: "review",
      type: "human",
      prompt: "Review acceptance fixture.",
    },
  ],
};

// --- M11c fixture A: settings VISIBLE on a parked review run ----------------
// A NeedsInput run parked at a `review` human node (no worktree, never resumes)
// whose `implement` ai_coding node carries `settings` with an all-`instruct`
// enforcement map. The run-detail settings panel reads the pinned manifest
// (flows.manifest fallback in getRunSettings) and runs evaluateNodeEnforcement
// live → every declared class resolves to `instructed`.

const M11C_VISIBLE_SLUG = "e2e-m11c-visible";
const M11C_VISIBLE_BRANCH = "maister/e2e-m11c-visible";
const M11C_VISIBLE_NODE = "implement";

const M11C_VISIBLE_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Settings Visible (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: M11C_VISIBLE_NODE,
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      transitions: { success: "review" },
      settings: {
        mcps: ["github"],
        tools: { claude: ["Edit"] },
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
      transitions: { approve: "done", rework: M11C_VISIBLE_NODE },
      rework: {
        allowedTargets: [M11C_VISIBLE_NODE],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
};

const M11C_VISIBLE_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: M11C_VISIBLE_NODE },
  reworkTargets: [M11C_VISIBLE_NODE],
  workspacePolicies: ["keep"],
};

// --- M11c fixture B: strict-enforcement REFUSAL at launch -------------------
// A launchable Backlog task whose enabled flow revision pins an ai_coding
// `implement` node declaring `enforcement.mcps: "strict"`. On the FROZEN
// all-instructed enforceability table no agent can strictly enforce `mcps`, so
// POST /api/runs refuses with CONFIG (400) at the settings-enforcement gate —
// BEFORE any worktree/run/workspace is created. The flow row is Enabled +
// trusted and points at a flow_revisions row carrying the strict manifest (the
// launch path resolves the manifest from flow.enabledRevisionId →
// flow_revisions.manifest, never from flows.manifest).

const M11C_REFUSE_SLUG = "e2e-m11c-refuse";
const M11C_REFUSE_NODE = "implement";

const M11C_REFUSE_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Strict Refusal (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: M11C_REFUSE_NODE,
      type: "ai_coding",
      action: { prompt: "/aif-implement {{ task.prompt }}" },
      transitions: { success: "done" },
      settings: { mcps: ["github"], enforcement: { mcps: "strict" } },
    },
  ],
};

// --- M19 fixture: reconcile + GC UI ----------------------------------------
// One project carrying a recoverable Crashed flow run plus two terminal
// Abandoned runs with staggered workspace removal deadlines. The Crashed run's
// `current_step_id` points at the manifest's `ai_coding` node so
// resolveCurrentNodeKind → "ai_coding" and the run-detail DTO computes
// recoverable:true (status Crashed + acpSessionId present + agent node). None of
// these runs resumes — no real worktree is provisioned (the M19 UI assertions
// are read-only: run-detail crashed section, board Crashed column, left-rail TTL
// badge, cron route). gcWarningDays defaults to 2 and gcAgeDays to 14.

const M19_SLUG = "e2e-m19";
const M19_CRASHED_BRANCH = "maister/e2e-m19-crashed";
const M19_WARNING_BRANCH = "maister/e2e-m19-warning";
const M19_DUE_BRANCH = "maister/e2e-m19-due";
const M19_AGENT_NODE = "implement";

const M19_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Reconcile/GC (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: M19_AGENT_NODE,
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      transitions: { success: "done" },
    },
  ],
};

function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeYamlLike(pathName: string, content: string): void {
  writeFileSync(pathName, `${content.trim()}\n`, "utf8");
}

async function createGitRepo(repoPath: string): Promise<void> {
  resetDir(repoPath);
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
  writeFileSync(path.join(repoPath, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["-C", repoPath, "add", "."]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "base"]);
}

function createLocalFlowSource(flowPath: string): void {
  resetDir(flowPath);
  writeYamlLike(
    path.join(flowPath, "flow.yaml"),
    `
schemaVersion: 1
name: Acceptance Flow
steps:
  - id: review
    type: human
    prompt: Review acceptance fixture.
`,
  );
}

function writeMaisterYaml(args: {
  repoPath: string;
  projectName: string;
  flowSource: string;
  executorId?: string;
  router?: "ccr";
  model?: string;
}): void {
  const routerLine = args.router ? `    router: ${args.router}\n` : "";

  writeYamlLike(
    path.join(args.repoPath, "maister.yaml"),
    `
schemaVersion: 2
project:
  name: ${args.projectName}
  repo_path: ${args.repoPath}
  main_branch: main
  branch_prefix: maister/
executors:
  - id: ${args.executorId ?? "claude-sonnet"}
    agent: claude
    model: ${args.model ?? "claude-sonnet-4-6"}
${routerLine}default_executor: ${args.executorId ?? "claude-sonnet"}
capabilities:
  mcps: []
  skills: []
  rules: []
  restrictions: []
  settings: []
  tools: []
flows:
  - id: acceptance
    source: ${args.flowSource}
    version: v0.0.1
`,
  );
}

function writeRegisterableMaisterYaml(args: {
  repoPath: string;
  projectName: string;
}): void {
  writeYamlLike(
    path.join(args.repoPath, "maister.yaml"),
    `
schemaVersion: 2
project:
  name: ${args.projectName}
  repo_path: ${args.repoPath}
  main_branch: main
  branch_prefix: maister/
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
default_executor: claude-sonnet
flows: []
`,
  );
}

async function insertUser(
  pool: Pool,
  input: {
    email: string;
    password: string;
    name: string;
    role: "admin" | "member" | "viewer";
    accountStatus: "pending" | "active" | "disabled";
    mustChangePassword: boolean;
  },
): Promise<UserFixture> {
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(input.password, 12);

  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role, account_status, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.name,
      input.email,
      passwordHash,
      input.role,
      input.accountStatus,
      input.mustChangePassword,
    ],
  );

  return {
    id,
    email: input.email,
    password: input.password,
    name: input.name,
  };
}

async function provisionWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  resetDir(repoPath);
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

async function seedLaunchableProjectFixture(
  pool: Pool,
  args: {
    slug: string;
    projectName: string;
    userId: string;
    repoPath: string;
    branchPrefix?: string;
    task?: {
      title: string;
      prompt: string;
      status: "Backlog" | "InFlight";
      stage: "Backlog" | "Prepare";
    };
    hitl?: boolean;
    executor?: {
      refId: string;
      agent: "claude" | "codex";
      model: string;
      router?: "ccr";
    };
  },
): Promise<ProjectFixture> {
  const ids = {
    project: randomUUID(),
    executor: randomUUID(),
    flow: randomUUID(),
    revision: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
  };
  const executor = args.executor ?? {
    refId: "claude-sonnet",
    agent: "claude" as const,
    model: "claude-sonnet-4-6",
  };
  const flowSource = path.join(RUNTIME_ROOT, "flows", `${args.slug}-flow`);

  createLocalFlowSource(flowSource);
  await createGitRepo(args.repoPath);
  writeMaisterYaml({
    repoPath: args.repoPath,
    projectName: args.projectName,
    flowSource,
    executorId: executor.refId,
    router: executor.router,
    model: executor.model,
  });
  await execFileAsync("git", ["-C", args.repoPath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    args.repoPath,
    "commit",
    "-m",
    "add maister config",
  ]);

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [args.slug]);
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, branch_prefix, maister_yaml_path)
     VALUES ($1, $2, $3, $4, 'main', $5, $6)`,
    [
      ids.project,
      args.slug,
      args.projectName,
      args.repoPath,
      args.branchPrefix ?? "maister/",
      path.join(args.repoPath, "maister.yaml"),
    ],
  );
  await pool.query(
    `INSERT INTO executors (id, project_id, executor_ref_id, agent, model, router)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.executor,
      ids.project,
      executor.refId,
      executor.agent,
      executor.model,
      executor.router ?? null,
    ],
  );
  await pool.query(
    `UPDATE projects SET default_executor_id = $1 WHERE id = $2`,
    [ids.executor, ids.project],
  );
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision, manifest_digest, manifest,
        schema_version, engine_min, installed_path, setup_status, package_status)
     VALUES ($1, 'acceptance', $2, 'v0.0.1', $3, $4, $5, 1, '1.0.0', $6,
        'not_required', 'Installed')`,
    [
      ids.revision,
      flowSource,
      randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40),
      `sha256:${ids.revision}`,
      JSON.stringify(LINEAR_MANIFEST),
      flowSource,
    ],
  );
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision, installed_path,
        manifest, schema_version, enabled_revision_id, enablement_state, trust_status)
     VALUES ($1, $2, 'acceptance', $3, 'v0.0.1', $4, $3, $5, 1, $6,
        'Enabled', 'trusted_by_policy')`,
    [
      ids.flow,
      ids.project,
      flowSource,
      ids.revision.replace(/-/g, "").padEnd(40, "0").slice(0, 40),
      JSON.stringify(LINEAR_MANIFEST),
      ids.revision,
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, args.userId],
  );

  const fixture: ProjectFixture = {
    projectId: ids.project,
    projectSlug: args.slug,
    repoPath: args.repoPath,
    executorId: ids.executor,
    flowId: ids.flow,
  };

  if (!args.task) {
    return fixture;
  }

  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ids.task,
      ids.project,
      args.task.title,
      args.task.prompt,
      ids.flow,
      args.task.status,
      args.task.stage,
    ],
  );
  fixture.taskId = ids.task;

  if (!args.hitl) {
    return fixture;
  }

  const hitlTaskId = randomUUID();
  const branch = `${args.branchPrefix ?? "maister/"}acceptance-needs-input`;
  const worktreePath = path.join(args.repoPath, ".worktrees", "needs-input");

  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      hitlTaskId,
      ids.project,
      "Acceptance review pending",
      "Seed a pending human review for the board and portfolio.",
      ids.flow,
    ],
  );
  await execFileAsync("git", [
    "-C",
    args.repoPath,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);
  await pool.query(
    `INSERT INTO runs
       (id, task_id, project_id, flow_id, executor_id, status, current_step_id,
        flow_version, flow_revision, flow_revision_id, started_at)
     VALUES ($1, $2, $3, $4, $5, 'NeedsInput', 'review',
        'v0.0.1', $6, $7, now())`,
    [
      ids.run,
      hitlTaskId,
      ids.project,
      ids.flow,
      ids.executor,
      ids.revision,
      ids.revision,
    ],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ids.workspace, ids.run, ids.project, branch, worktreePath, args.repoPath],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify({
        review: true,
        allowedDecisions: ["approve", "rework"],
        transitions: { approve: "done", rework: "review" },
      }),
      "Acceptance review is waiting on you.",
    ],
  );

  fixture.runId = ids.run;
  fixture.hitlRequestId = ids.hitl;
  fixture.branch = branch;
  fixture.worktreePath = worktreePath;

  return fixture;
}

async function createRegistrationFixture(): Promise<RegistrationFixture> {
  const repoPath = path.join(RUNTIME_ROOT, "repos", REGISTRATION_SLUG);
  const duplicateRepoPath = path.join(
    RUNTIME_ROOT,
    "repos",
    REGISTRATION_DUP_SLUG,
  );

  for (const candidate of [
    { path: repoPath, name: "E2E Registerable" },
    { path: duplicateRepoPath, name: "E2E Registerable Dup" },
  ]) {
    await createGitRepo(candidate.path);
    writeRegisterableMaisterYaml({
      repoPath: candidate.path,
      projectName: candidate.name,
    });
    await execFileAsync("git", ["-C", candidate.path, "add", "."]);
    await execFileAsync("git", [
      "-C",
      candidate.path,
      "commit",
      "-m",
      "add maister config",
    ]);
  }

  return {
    repoPath,
    duplicateRepoPath,
    expectedSlug: REGISTRATION_SLUG,
    duplicateSlug: REGISTRATION_DUP_SLUG,
  };
}

async function seedM11cVisibleFixture(
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
  const worktreePath = `${repoPath}/.worktrees/e2e-m11c-visible`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M11C_VISIBLE_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      ids.project,
      M11C_VISIBLE_SLUG,
      "MAIster E2E M11c Visible",
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
      `/tmp/maister-e2e/flows/aif-m11c-visible@v0.0.1`,
      JSON.stringify(M11C_VISIBLE_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E settings visible", "do the thing", ids.flow],
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
      M11C_VISIBLE_BRANCH,
      worktreePath,
      repoPath,
    ],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(M11C_VISIBLE_REVIEW_SCHEMA),
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
    projectSlug: M11C_VISIBLE_SLUG,
    branch: M11C_VISIBLE_BRANCH,
    worktreePath,
  };
}

async function seedM11cRefuseFixture(
  pool: Pool,
  userId: string,
): Promise<RefuseFixtureRecord> {
  const ids = {
    project: randomUUID(),
    executor: randomUUID(),
    flow: randomUUID(),
    revision: randomUUID(),
    task: randomUUID(),
    member: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const installedPath = `/tmp/maister-e2e/flows/aif-m11c-refuse@v0.0.1`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M11C_REFUSE_SLUG]);
  // flow_revisions is project-independent (keyed by flow_ref_id + resolved
  // revision); delete the prior row by that unique key for idempotency.
  await pool.query(
    `DELETE FROM flow_revisions WHERE flow_ref_id = 'aif-m11c-refuse'`,
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path)
     VALUES ($1, $2, $3, $4, 'main', $5)`,
    [
      ids.project,
      M11C_REFUSE_SLUG,
      "MAIster E2E M11c Refuse",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO executors (id, project_id, executor_ref_id, agent, model)
     VALUES ($1, $2, 'claude-sonnet', 'claude', 'claude-sonnet-4-6')`,
    [ids.executor, ids.project],
  );
  // The enabled revision the launch path resolves the manifest from. Installed +
  // setup done + supported schema + engine-compatible so launch reaches the
  // settings-enforcement gate rather than failing an earlier precondition.
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision, manifest_digest,
        manifest, schema_version, engine_min, installed_path, setup_status, package_status)
     VALUES ($1, 'aif-m11c-refuse', $2, 'v0.0.1', 'rev-m11c-refuse', 'sha-m11c-refuse',
        $3, 1, '1.1.0', $4, 'done', 'Installed')`,
    [
      ids.revision,
      "github.com/maister/maister-flow-aif",
      JSON.stringify(M11C_REFUSE_MANIFEST),
      installedPath,
    ],
  );
  // The project flow row: Enabled + trusted, pointing at the strict revision.
  // recommended_executor_id resolves the executor (the flowRecommended tier) so
  // resolveExecutor does not throw EXECUTOR_UNAVAILABLE before the settings gate
  // — the project has no default_executor_id and the task no override.
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision, installed_path, manifest,
        schema_version, recommended_executor_id, enabled_revision_id, enablement_state, trust_status)
     VALUES ($1, $2, 'aif-m11c-refuse', $3, 'v0.0.1', 'rev-m11c-refuse', $4, $5, 1,
        $6, $7, 'Enabled', 'trusted')`,
    [
      ids.flow,
      ids.project,
      "github.com/maister/maister-flow-aif",
      installedPath,
      JSON.stringify(M11C_REFUSE_MANIFEST),
      ids.executor,
      ids.revision,
    ],
  );
  // A launchable Backlog task → the board shows a Launch button on its card.
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'Backlog', 'Backlog')`,
    [
      ids.task,
      ids.project,
      "E2E strict refusal",
      "implement the feature",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  return {
    projectSlug: M11C_REFUSE_SLUG,
    taskId: ids.task,
    nodeId: M11C_REFUSE_NODE,
    refusedClass: "mcps",
  };
}

type M19FixtureRecord = {
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

async function seedM19Fixture(
  pool: Pool,
  userId: string,
): Promise<M19FixtureRecord> {
  const ids = {
    project: randomUUID(),
    executor: randomUUID(),
    flow: randomUUID(),
    member: randomUUID(),
    crashedTask: randomUUID(),
    crashedRun: randomUUID(),
    crashedWorkspace: randomUUID(),
    crashedAttempt: randomUUID(),
    warningTask: randomUUID(),
    warningRun: randomUUID(),
    warningWorkspace: randomUUID(),
    dueTask: randomUUID(),
    dueRun: randomUUID(),
    dueWorkspace: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const now = Date.now();
  const DAY_MS = 86_400_000;
  // gcWarningDays defaults to 2 → warning deadline 1 day out (inside window).
  const warningRemovalAt = new Date(now + 1 * DAY_MS).toISOString();
  // due deadline already past → ttlState "due".
  const dueRemovalAt = new Date(now - 1 * DAY_MS).toISOString();

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M19_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path)
     VALUES ($1, $2, $3, $4, 'main', $5)`,
    [
      ids.project,
      M19_SLUG,
      "MAIster E2E M19",
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
    `UPDATE projects SET default_executor_id = $1 WHERE id = $2`,
    [ids.executor, ids.project],
  );
  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
    [
      ids.flow,
      ids.project,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-m19@v0.0.1`,
      JSON.stringify(M19_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  // (1) Recoverable Crashed flow run: acp_session_id present + current node is
  // the ai_coding node → run-detail recoverable:true, board Crashed column.
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.crashedTask,
      ids.project,
      "E2E crashed recoverable",
      "do the thing",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, executor_id, status, current_step_id, acp_session_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'Crashed', $6, 'acp-m19-crashed', 'v0.0.1', now(), now())`,
    [
      ids.crashedRun,
      ids.crashedTask,
      ids.project,
      ids.flow,
      ids.executor,
      M19_AGENT_NODE,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status)
     VALUES ($1, $2, $3, 'ai_coding', 1, 'Crashed')`,
    [ids.crashedAttempt, ids.crashedRun, M19_AGENT_NODE],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.crashedWorkspace,
      ids.crashedRun,
      ids.project,
      M19_CRASHED_BRANCH,
      `${repoPath}/.worktrees/m19-crashed`,
      repoPath,
    ],
  );

  // (2) Abandoned run, workspace removal inside the warning window.
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'Abandoned', 'Backlog')`,
    [ids.warningTask, ids.project, "E2E ttl warning", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, executor_id, status, current_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'Abandoned', $6, 'v0.0.1', now(), now())`,
    [
      ids.warningRun,
      ids.warningTask,
      ids.project,
      ids.flow,
      ids.executor,
      M19_AGENT_NODE,
    ],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, scheduled_removal_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ids.warningWorkspace,
      ids.warningRun,
      ids.project,
      M19_WARNING_BRANCH,
      `${repoPath}/.worktrees/m19-warning`,
      repoPath,
      warningRemovalAt,
    ],
  );

  // (3) Abandoned run, workspace removal deadline already past (due).
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, $3, $4, $5, 'Abandoned', 'Backlog')`,
    [ids.dueTask, ids.project, "E2E ttl due", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, executor_id, status, current_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'Abandoned', $6, 'v0.0.1', now(), now())`,
    [
      ids.dueRun,
      ids.dueTask,
      ids.project,
      ids.flow,
      ids.executor,
      M19_AGENT_NODE,
    ],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, scheduled_removal_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ids.dueWorkspace,
      ids.dueRun,
      ids.project,
      M19_DUE_BRANCH,
      `${repoPath}/.worktrees/m19-due`,
      repoPath,
      dueRemovalAt,
    ],
  );

  return {
    projectId: ids.project,
    projectSlug: M19_SLUG,
    repoPath,
    crashedRunId: ids.crashedRun,
    crashedBranch: M19_CRASHED_BRANCH,
    warningRunId: ids.warningRun,
    warningBranch: M19_WARNING_BRANCH,
    dueRunId: ids.dueRun,
    dueBranch: M19_DUE_BRANCH,
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
    await pool.query(`DELETE FROM projects WHERE slug = ANY($1::text[])`, [
      [
        M11A_SLUG,
        M11B_SLUG,
        BOARD_SLUG,
        SCRATCH_SLUG,
        REGISTRATION_SLUG,
        REGISTRATION_DUP_SLUG,
        LIVE_CCR_SLUG,
        M11C_VISIBLE_SLUG,
        M11C_REFUSE_SLUG,
        M19_SLUG,
      ],
    ]);
    await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [
      [
        ADMIN_EMAIL,
        MUST_CHANGE_EMAIL,
        PENDING_EMAIL,
        DISABLED_EMAIL,
        MEMBER_EMAIL,
        EDIT_TARGET_EMAIL,
      ],
    ]);

    const admin = await insertUser(pool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      name: "E2E Admin",
      role: "admin",
      accountStatus: "active",
      mustChangePassword: false,
    });
    const mustChange = await insertUser(pool, {
      email: MUST_CHANGE_EMAIL,
      password: MUST_CHANGE_PASSWORD,
      name: "E2E Must Change",
      role: "member",
      accountStatus: "active",
      mustChangePassword: true,
    });
    const pending = await insertUser(pool, {
      email: PENDING_EMAIL,
      password: PENDING_PASSWORD,
      name: "E2E Pending",
      role: "member",
      accountStatus: "pending",
      mustChangePassword: false,
    });
    const disabled = await insertUser(pool, {
      email: DISABLED_EMAIL,
      password: DISABLED_PASSWORD,
      name: "E2E Disabled",
      role: "member",
      accountStatus: "disabled",
      mustChangePassword: false,
    });
    const member = await insertUser(pool, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
      name: "E2E Member",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    });
    const editTarget = await insertUser(pool, {
      email: EDIT_TARGET_EMAIL,
      password: EDIT_TARGET_PASSWORD,
      name: "E2E Edit Target",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    });

    const m11a = await seedM11aFixture(pool, admin.id);
    const m11b = await seedM11bFixture(pool, admin.id);
    const board = await seedLaunchableProjectFixture(pool, {
      slug: BOARD_SLUG,
      projectName: "E2E Acceptance Board",
      userId: admin.id,
      repoPath: path.join(RUNTIME_ROOT, "repos", BOARD_SLUG),
      task: {
        title: "Acceptance backlog launch",
        prompt: "Exercise supervisor readiness gating.",
        status: "Backlog",
        stage: "Backlog",
      },
      hitl: true,
    });
    const scratch = await seedLaunchableProjectFixture(pool, {
      slug: SCRATCH_SLUG,
      projectName: "E2E Acceptance Scratch",
      userId: admin.id,
      repoPath: path.join(RUNTIME_ROOT, "repos", SCRATCH_SLUG),
    });
    const liveCcr = await seedLaunchableProjectFixture(pool, {
      slug: LIVE_CCR_SLUG,
      projectName: "E2E Live CCR",
      userId: admin.id,
      repoPath: path.join(RUNTIME_ROOT, "repos", LIVE_CCR_SLUG),
      executor: {
        refId: "claude-ccr-live",
        agent: "claude",
        model: process.env.E2E_CCR_EXECUTOR_MODEL ?? "e2e-live-model",
        router: "ccr",
      },
    });
    const registration = await createRegistrationFixture();
    const m11cVisible = await seedM11cVisibleFixture(pool, admin.id);
    const m11cRefuse = await seedM11cRefuseFixture(pool, admin.id);
    const m19 = await seedM19Fixture(pool, admin.id);

    await pool.query(
      `INSERT INTO project_members (id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), board.projectId, editTarget.id],
    );

    // fixtures.json: shared admin creds + a per-spec record under `byKey`. The
    // top-level run/hitl/branch fields preserve the M11a spec's existing reads.
    const fixtures = {
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      runId: m11a.runId,
      hitlRequestId: m11a.hitlRequestId,
      projectSlug: m11a.projectSlug,
      branch: m11a.branch,
      users: {
        admin,
        mustChange,
        pending,
        disabled,
        member,
        editTarget,
      },
      byKey: {
        m11a,
        m11b,
        board,
        scratch,
        liveCcr,
        registration,
        m11cVisible,
        m11cRefuse,
        m19,
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
      `seed-e2e: seeded m11a ${m11a.runId}, m11b ${m11b.runId}, board ${board.projectSlug}, scratch ${scratch.projectSlug}` +
        `, m11c-visible ${m11cVisible.runId} (${M11C_VISIBLE_SLUG}), m11c-refuse ${m11cRefuse.taskId} (${M11C_REFUSE_SLUG})` +
        `, m19 crashed ${m19.crashedRunId} (${M19_SLUG})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-e2e failed:", err);
  process.exit(1);
});
