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

type SeedAdapterId = "claude" | "codex" | "gemini" | "opencode" | "mimo";

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
const DELETABLE_EMAIL = "e2e-deletable@maister.local";
const DELETABLE_PASSWORD = "E2eDeletable!pass1";
const MEMBER_CANDIDATE_EMAIL = "e2e-member-candidate@maister.local";
const MEMBER_CANDIDATE_PASSWORD = "E2eMemberCandidate!pass1";

const BOARD_SLUG = "e2e-acceptance-board";
const SCRATCH_SLUG = "e2e-acceptance-scratch";
const REGISTRATION_SLUG = "e2e-registerable";
const REGISTRATION_DUP_SLUG = "e2e-registerable-dup";
const LIVE_CCR_SLUG = "e2e-live-ccr";

const RUNTIME_ROOT = "/tmp/maister-e2e";
const PLATFORM_DEFAULT_RUNNER_ID = "claude-code";
const CODEX_RUNNER_ID = "codex-openai";
const CCR_SIDECAR_ID = "ccr-default";
const CCR_RUNNER_ID = "claude-code-ccr";
const NOT_READY_RUNNER_ID = "codex-zai-glm";

// M42 (ADR-114): `runs` no longer carries the runner/resume mirror columns
// (runner_id, runner_resolution_tier, capability_agent, runner_snapshot,
// acp_session_id) — `run_sessions` is the SOLE source of truth. Seeds insert the
// run WITHOUT those columns, then add the run's `default` session via
// `seedDefaultRunSession` (mirrors the production insert in lib/services/runs.ts).
function e2eClaudeRunnerSnapshot(runnerId: string) {
  return {
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    providerKind: "anthropic",
    permissionPolicy: "default",
    sidecar: null,
    sidecarId: null,
  };
}

async function seedDefaultRunSession(
  pool: Pool,
  args: {
    acpSessionId?: string | null;
    capabilityAgent?: string | null;
    runId: string;
    runnerId: string | null;
    runnerResolutionTier?: string | null;
    runnerSnapshot?: unknown;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO run_sessions (id, run_id, session_name, runner_id, runner_resolution_tier, capability_agent, runner_snapshot, acp_session_id)
     VALUES ($1, $2, 'default', $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, session_name) DO NOTHING`,
    [
      randomUUID(),
      args.runId,
      args.runnerId,
      args.runnerResolutionTier ?? null,
      args.capabilityAgent ?? null,
      args.runnerSnapshot != null ? JSON.stringify(args.runnerSnapshot) : null,
      args.acpSessionId ?? null,
    ],
  );
}

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

// --- Review-comments fixture (ADR-072): review gate + anchored threads ------
// A NeedsInput run parked at the graph `review` human gate with a REAL parent
// repo + worktree carrying ONE committed change (src/greeting.ts added on the
// run branch), so GET /diff and the review-comment anchor lib operate on a real
// committed base..branch diff. Seeded review_comments: two OPEN inline roots
// whose line_content byte-matches the fixture diff (single source of truth:
// RC_FILE_LINES — the worktree file AND the stored line_content are written
// from the same array), one of them carrying a reply; plus one OPEN root whose
// stored line_content deliberately mismatches → placement "outdated". The
// pending gate's schema carries {review, maxLoops, gateAttempt} so the loop
// chip renders (ADR-072 D5); a PRIOR responded review hitl row (visit 1)
// anchors the seeded threads' FK + gate_attempt=1. The review-comments e2e
// spec adds a root + reply through the UI, resolves a thread, and submits the
// rework decision.

const RC_SLUG = "e2e-review-comments";
const RC_BRANCH = "maister/e2e-review-comments";
const RC_FILE_PATH = "src/greeting.ts";
const RC_FILE_LINES = [
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
  'export const VERSION = "1.0.0";',
];
const RC_STALE_LINE_CONTENT = "} // stale snapshot from review visit 1";
const RC_MAX_LOOPS = 3;
const RC_GATE_ATTEMPT = 2;

const RC_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
  maxLoops: RC_MAX_LOOPS,
  gateAttempt: RC_GATE_ATTEMPT,
};

const RC_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Review Comments (e2e)",
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
        maxLoops: RC_MAX_LOOPS,
        commentsVar: "review_comments",
      },
    },
  ],
};

type ReviewCommentsFixtureRecord = FixtureRecord & {
  filePath: string;
  // Seeded threads (anchor line on the NEW side + body text the spec asserts).
  inline: { line: number; body: string; reply: string };
  second: { line: number; body: string };
  outdated: { line: number; body: string; staleContent: string };
  // A diff line with NO seeded thread — free for the spec's UI-added root.
  composeLine: number;
  maxLoops: number;
  gateAttempt: number;
};

// --- M12 fixture: evidence-graph surface on a parked review run --------------
// A NeedsInput run parked at the aif `review` node with a full M12 evidence
// trail: node_attempts (plan/implement/checks/judge Succeeded → review
// NeedsInput), artifact_instances (plan-summary, impl-diff [requiredFor
// review+merge, inline locator so the payload route returns text without git],
// lint-report, judge-verdict — all `current`), and a PASSED blocking
// artifact_required gate on the review attempt. The e2e spec drives the
// evidence explorer, the artifact payload drawer, and the board
// mergeBlocked/evidenceStale pills (by flipping validity/gate status in-DB).

const M12_SLUG = "e2e-m12";
const M12_BRANCH = "maister/e2e-evidence";

const M12_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

// The migrated aif manifest (M12 typed artifacts) — kept in lockstep with
// the AIF flow fixture so the run-detail settings/evidence reads resolve.
const M12_MANIFEST = {
  schemaVersion: 1,
  name: "aif",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "/aif-plan {{ task.prompt }}" },
      output: { produces: [{ id: "plan-summary", kind: "human_note" }] },
      transitions: { success: "implement" },
    },
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      input: { requires: [{ artifact: "plan-summary", kind: "human_note" }] },
      output: {
        produces: [
          { id: "impl-diff", kind: "diff", requiredFor: ["review", "merge"] },
        ],
      },
      transitions: { success: "checks" },
    },
    {
      id: "checks",
      type: "check",
      action: { command: "pnpm -s lint" },
      output: { produces: [{ id: "lint-report", kind: "lint_report" }] },
      transitions: { success: "judge" },
    },
    {
      id: "judge",
      type: "judge",
      action: { prompt: "Review the implementation diff." },
      input: {
        requires: [
          { artifact: "impl-diff", kind: "diff" },
          { artifact: "lint-report", kind: "lint_report" },
        ],
      },
      output: { produces: [{ id: "judge-verdict", kind: "ai_judgment" }] },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      input: { requires: [{ artifact: "judge-verdict", kind: "ai_judgment" }] },
      pre_finish: {
        gates: [
          {
            id: "impl-diff-required",
            kind: "artifact_required",
            mode: "blocking",
            inputArtifacts: ["impl-diff"],
          },
        ],
      },
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework", "takeover"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "implement", takeover: "checks" },
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

// The M12 evidence fixture additionally carries the impl-diff artifact id and
// the artifact_required gate id so the e2e spec can flip them in-DB (stale /
// failed → and back) to drive the board mergeBlocked/evidenceStale pills.
type M12FixtureRecord = FixtureRecord & {
  implDiffArtifactId: string;
  gateResultId: string;
};

// The M15 readiness fixture carries two run IDs (failed + overridden) to test
// the readiness badge and panel with different gate statuses.
type M15FixtureRecord = {
  projectSlug: string;
  failedRunId: string;
  failedHitlRequestId: string;
  overriddenRunId: string;
  overriddenHitlRequestId: string;
  gateId: string;
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
  runnerId: string;
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

// --- M34 platform-agents fixtures (ADR-089) ---------------------------------
// One launchable project carrying: a Backlog task for the manual agent launch
// (spec a), a repo_read auditor agent for the quarantine path (spec c), and a
// SECOND task bound to a graph flow whose ai_coding node declares
// `settings.agent` (spec b). The stub supervisor records every prompt, so the
// binding spec asserts the substituted system prompt by its marker line.
const AGENTS_SLUG = "e2e-agents";
// ADR-089 rework: package-qualified agent ids `<flowRefId>:<stem>`.
const E2E_HELPER_AGENT = "e2e-agents-pkg:e2e-helper";
const E2E_AUDITOR_AGENT = "e2e-agents-pkg:e2e-auditor";
const AGENT_BODY_MARKER = "E2E-HELPER-SYSTEM-PROMPT-MARKER";

// --- M37 orchestrator-loop fixture (ADR-098) --------------------------------
// One launchable project carrying a Backlog task bound to a graph flow whose
// single node is an `orchestrator` (engine_min 1.6.0) + a catalog `worker`
// agent (workspace=none, so a delegated child finalizes Done) attached to the
// project. The orchestrator-loop spec launches the task from the board; the
// test supervisor (wired in global-setup) simulates the coordinator's agent
// session and spawns 2 children through the REAL ext delegate HTTP route, the
// orchestrator parks on WaitingOnChildren, and the run-tree subtree renders the
// 2 children on the orchestrator's workbench.
const ORCHESTRATOR_SLUG = "e2e-orchestrator";
const E2E_WORKER_AGENT = "e2e-orc-pkg:e2e-worker";

const ORCHESTRATOR_MANIFEST = {
  schemaVersion: 1,
  name: "E2E Orchestrator",
  compat: { engine_min: "1.6.0" },
  nodes: [
    {
      id: "coordinate",
      type: "orchestrator",
      action: { prompt: "/coordinate the delivery into sub-tasks" },
      transitions: { success: "done" },
    },
  ],
};

type OrchestratorFixture = ProjectFixture & {
  // The catalog agent the orchestrator delegates each child to.
  workerAgentId: string;
  // The Backlog task's KEY-N number (the board launch target).
  taskNumber: number;
  // The agent-package install root the test supervisor's delegation resolves.
  agentsRoot: string;
};

const AGENTS_BINDING_MANIFEST = {
  schemaVersion: 1,
  name: "Agent Bound (e2e)",
  compat: { engine_min: "1.5.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "Apply the bound-agent e2e change." },
      settings: { agent: E2E_HELPER_AGENT },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve"] },
      },
      transitions: { approve: "done" },
    },
  ],
};

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

// --- Flow Studio Phase 2 (T2.5) fixture: installed-package viewer + fork ----
// A REAL on-disk immutable bundle (written to /tmp/maister-e2e/flows/...) plus
// the `flows` + enabled `flow_revisions` rows that point at it. The nav-path
// e2e (flow-package-viewer.spec.ts) clicks: board → Packages tab → package card
// → viewer (static graph + raw flow.yaml + a file from the list) → Fork → the
// authored-flow editor → Save. The manifest is a graph with two presentation-
// positioned nodes so the static graph renders honoring x/y; every bundle file
// is valid UTF-8 text so the fork reads it cleanly. `name` is slug-shaped so
// `resolvePackageSlug` (fork path) resolves from the manifest, never the `@`-dir
// basename.
const FLOW_VIEWER_SLUG = "e2e-flow-viewer";
const FLOW_VIEWER_REF = "aif-flow-viewer";
const FLOW_VIEWER_VERSION = "v0.0.1";
const FLOW_VIEWER_IMPLEMENT_NODE = "implement";
const FLOW_VIEWER_REVIEW_NODE = "review";

const FLOW_VIEWER_MANIFEST = {
  schemaVersion: 1,
  name: "flow-package-viewer-demo",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: FLOW_VIEWER_IMPLEMENT_NODE,
      type: "ai_coding",
      action: { prompt: "/aif-implement {{ task.prompt }}" },
      transitions: { success: FLOW_VIEWER_REVIEW_NODE },
    },
    {
      id: FLOW_VIEWER_REVIEW_NODE,
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
      transitions: { approve: "done", rework: FLOW_VIEWER_IMPLEMENT_NODE },
      rework: {
        allowedTargets: [FLOW_VIEWER_IMPLEMENT_NODE],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
  presentation: {
    nodes: [
      { id: FLOW_VIEWER_IMPLEMENT_NODE, x: 80, y: 60 },
      { id: FLOW_VIEWER_REVIEW_NODE, x: 80, y: 260 },
    ],
  },
};

// The raw flow.yaml written to disk + read read-only by the viewer. Kept
// byte-consistent with FLOW_VIEWER_MANIFEST (same nodes/presentation) so the
// rendered graph and the raw text agree.
const FLOW_VIEWER_FLOW_YAML = `schemaVersion: 1
name: flow-package-viewer-demo
compat:
  engine_min: "1.1.0"
nodes:
  - id: ${FLOW_VIEWER_IMPLEMENT_NODE}
    type: ai_coding
    action:
      prompt: "/aif-implement {{ task.prompt }}"
    transitions:
      success: ${FLOW_VIEWER_REVIEW_NODE}
  - id: ${FLOW_VIEWER_REVIEW_NODE}
    type: human
    finish:
      human:
        role: maintainer
        decisions: [approve, rework]
    transitions:
      approve: done
      rework: ${FLOW_VIEWER_IMPLEMENT_NODE}
    rework:
      allowedTargets: [${FLOW_VIEWER_IMPLEMENT_NODE}]
      workspacePolicies: [keep]
      maxLoops: 3
      commentsVar: review_comments
presentation:
  nodes:
    - id: ${FLOW_VIEWER_IMPLEMENT_NODE}
      x: 80
      y: 60
    - id: ${FLOW_VIEWER_REVIEW_NODE}
      x: 80
      y: 260
`;

// Bundle artifact files (besides flow.yaml). Each is valid UTF-8 text so the
// fork's `readAuthoredFlowPackageDirectory` decodes them without throwing, and
// each classifies to its kind by path (skills/→skill, rules/→rule, etc.).
const FLOW_VIEWER_BUNDLE_FILES: Record<string, string> = {
  "skills/demo/SKILL.md": `---
name: demo
description: A demo skill bundled with the viewer fixture flow.
---

# Demo skill

This skill exists to populate the package file list for the viewer e2e.
`,
  "rules/guard.md": `---
allowed_paths:
  - src/**
forbidden_paths:
  - .git/**
---

# Guard rule

Keep edits inside src.
`,
  "schemas/review.json": `${JSON.stringify(
    {
      schemaVersion: 1,
      fields: [
        {
          name: "decision",
          label: "Decision",
          type: "enum",
          required: true,
          options: ["approve", "rework"],
        },
        { name: "notes", label: "Notes", type: "string" },
      ],
    },
    null,
    2,
  )}\n`,
  "scripts/run.sh": `#!/usr/bin/env bash
set -euo pipefail
echo "viewer fixture script"
`,
  "setup.sh": `#!/usr/bin/env bash
set -euo pipefail
echo "viewer fixture setup (never executed by the fork)"
`,
  "README.md": `# flow-package-viewer-demo

Fixture flow package for the Flow Studio Phase 2 nav-path e2e.
`,
};

type FlowViewerFixtureRecord = {
  projectSlug: string;
  flowRefId: string;
  revisionId: string;
  implementNode: string;
  reviewNode: string;
  // A bundle file the spec opens from the viewer's file list (kind: skill).
  sampleFilePath: string;
};

// Local copy of `@/lib/flows/editor/package-file-tree` `classifyPackageFilePath`
// (the seeder cannot import app modules). Used to build the artifacts fixture's
// `body.files[].kind` the same way `readAuthoredFlowPackageDirectory` would.
type BundleFileKind =
  | "readme"
  | "setup"
  | "schema"
  | "skill"
  | "rule"
  | "agent_definition"
  | "script"
  | "template"
  | "asset";

function classifyBundlePath(relativePath: string): BundleFileKind {
  if (relativePath === "README.md") return "readme";
  if (relativePath === "setup.sh") return "setup";
  if (relativePath.startsWith("schemas/")) return "schema";
  if (relativePath.startsWith("skills/")) return "skill";
  if (relativePath.startsWith("rules/")) return "rule";
  if (relativePath.startsWith("agents/")) return "agent_definition";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("templates/")) return "template";

  return "asset";
}

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
const M19_NOT_RECOVERABLE_BRANCH = "maister/e2e-m19-not-recoverable";
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

// --- M15 fixture: readiness summary badge & panel coverage ------------------
// ONE project carrying TWO seeded runs to demonstrate readiness badge on
// board/portfolio cards and the run-detail ReadinessSummary panel:
//   • A run in Review with a BLOCKING gate seeded `failed` → board/portfolio
//     show [data-readiness="failed"]; run-detail panel shows "Failed" state +
//     reason.
//   • A run in Review with the SAME gate OVERRIDDEN → board/portfolio show
//     [data-readiness="overridden"]; panel shows "Overridden" state.
// Both runs use a manifest with a blocking gate, no worktree provisioned
// (readiness is pure DB gate_results read, supervisor-independent).

const M15_SLUG = "e2e-m15";
const M15_FAILED_BRANCH = "maister/e2e-m15-failed";
const M15_OVERRIDDEN_BRANCH = "maister/e2e-m15-overridden";
const M15_GATE_ID = "quality-check";

const M15_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Readiness (e2e)",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      pre_finish: {
        gates: [
          {
            id: M15_GATE_ID,
            kind: "external_check",
            mode: "blocking",
            external: {
              description: "Quality check required",
              staleOnNewCommit: false,
            },
          },
        ],
      },
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
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

const M15_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

// --- M16 fixture: external-operations API ------------------------------------
// ONE launchable project carrying a Backlog task (token-auth task-create +
// run-launch land a real 201/202 against the same enabled flow path the board
// fixture uses) AND a SEPARATE review run parked at a `review` human node whose
// pre_finish declares a BLOCKING `external_check` gate seeded `pending`. The
// gate is the vehicle for the readiness / gate-report / re-stale / evidence
// steps — all supervisor-independent, driven from seeded DB rows. The review
// run's flow row carries M16_MANIFEST so resolveGateExternalConfig reads the
// gate's `external` block (staleOnNewCommit) from nodes[].pre_finish.gates[].

const M16_SLUG = "e2e-m16";
const M16_REVIEW_BRANCH = "maister/e2e-m16-review";
const M16_GATE_ID = "ci-test-report";

const M16_MANIFEST = {
  schemaVersion: 1,
  name: "AIF External Check (e2e)",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      pre_finish: {
        gates: [
          {
            id: M16_GATE_ID,
            kind: "external_check",
            mode: "blocking",
            external: {
              description: "CI test report required",
              staleOnNewCommit: true,
            },
          },
        ],
      },
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
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

const M16_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

// --- M18 fixture: flow runs at `Review` for branch-targeted promotion --------
// ONE project with a REAL parent git repo (a `release` target branch + a base
// commit) and THREE flow runs parked at `status='Review'`, each on its OWN run
// branch + real worktree carrying a committed change so `diffRange` renders and
// `promoteLocalMerge` (`git merge --no-ff`) actually runs:
//   • `merge`    — run branch off `release` with a non-conflicting commit. The
//     spec opens the ReviewPanel, asserts the diff + "Promote to release", clicks
//     promote (local_merge) → run reaches `Done` (clean `--no-ff` merge).
//   • `conflict` — run branch + `release` both edit the SAME line, so the
//     `--no-ff` merge aborts → CONFLICT → the conflict/assignment card surfaces.
//   • `pr`       — promotion_mode `pull_request` with a PRE-SEEDED `pr_url`/
//     `pr_number` (PR exec is NOT run in CI — display only: the panel/board shows
//     the PR link / `PR #N`).
// No blocking gates on any run → readiness rolls up `ready` (the promote gate
// passes). The flow manifest is the minimal implement→review shape (like M11a).

// --- M17 fixture: cross-project HITL inbox with graph human_review ---------
// Two projects each with runs in NeedsInput + pending HITL requests:
// - Project 1: permission kind (binary) + human_review kind with criticality badge
// - Project 2: human_review kind with on_reject send-back schema
// Inbox appears on portfolio home with count badge.

const M17_PROJECT1_SLUG = "e2e-m17-project1";
const M17_PROJECT2_SLUG = "e2e-m17-project2";
const M17_BRANCH1 = "maister/e2e-m17-proj1";
const M17_BRANCH2 = "maister/e2e-m17-proj2";

const M17_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

const M17_MANIFEST = {
  schemaVersion: 1,
  name: "AIF HITL (e2e)",
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

const M18_SLUG = "e2e-m18";
const M18_TARGET_BRANCH = "release";
const M18_MERGE_BRANCH = "maister/e2e-m18-merge";
const M18_CONFLICT_BRANCH = "maister/e2e-m18-conflict";
const M18_PR_BRANCH = "maister/e2e-m18-pr";
const M18_PR_URL = "https://github.com/maister/maister/pull/4242";
const M18_PR_NUMBER = 4242;
const M18_REVIEW_NODE = "review";

const M18_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Promote (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      prompt: "implement {{ task.prompt }}",
    },
    {
      id: M18_REVIEW_NODE,
      type: "human",
      decisions: ["approve", "rework"],
      transitions: { approve: "done", rework: "implement" },
    },
  ],
};

const M18_REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

// --- M27 fixture: workbench lifecycle actions ------------------------------
// One project with a Review flow workbench and a Review scratch workbench, both
// backed by real git worktrees and a file-based `origin` remote. The flow
// worktree carries dirty untracked work so the smoke can snapshot, create a
// handoff branch, archive, and drop without sharing mutable state with M18/M22.

const M27_SLUG = "e2e-m27";
const M27_FLOW_BRANCH = "maister/e2e-m27-flow";
const M27_SCRATCH_BRANCH = "maister/e2e-m27-scratch";

const M27_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Lifecycle (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
      transitions: { approve: "done", rework: "implement" },
    },
  ],
};

// --- M22 fixture: workbench (flow-graph view + git-tracked file tree + diff) --
// ONE project with a REAL parent repo carrying TRACKED files (README.md, a
// src/ subdir, AND an oversized blob > 524288 bytes so the too-large marker is
// exercised), plus a run branch carrying a committed DIFF off base so the Diff
// tab renders changed-files. ONE flow run parked at `Running` with
// `current_step_id` = the `implement` node, real node_attempts (plan Succeeded,
// implement Running on the current node, review Pending) + a PASSED gate so node
// colors and current-node emphasis are assertable. A VIEWER user + a viewer
// project_members row proves the readRepoFiles member-gate (viewer → 403).

const M22_SLUG = "e2e-m22";
const M22_BRANCH = "maister/e2e-m22-workbench";
const M22_CURRENT_NODE = "implement";
const M22_VIEWER_EMAIL = "e2e-m22-viewer@maister.local";
const M22_VIEWER_PASSWORD = "E2eM22Viewer!pass1";
// > 524288 (DEFAULT_WORKBENCH_MAX_FILE_BYTES) so readBlob reports too-large.
const M22_OVERSIZED_BYTES = 600_000;

// implement (ai_coding, current node, Running) -> checks (check + a PASSED
// command_check gate) -> review (human). The compiled topology node ids equal
// these manifest node ids, so current_step_id='implement' and the node_attempts
// statuses both map onto real flow-graph nodes.
const M22_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Workbench (e2e)",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "/aif-plan {{ task.prompt }}" },
      transitions: { success: M22_CURRENT_NODE },
    },
    {
      id: M22_CURRENT_NODE,
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "checks" },
    },
    {
      id: "checks",
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
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve", "rework"] },
      },
      transitions: { approve: "done", rework: M22_CURRENT_NODE },
    },
  ],
  // Authored layout (ADR-064): node positions ship in the flow manifest, read
  // by the read-only flow-graph view. There is no runtime layout store.
  presentation: {
    nodes: [
      { id: "plan", x: 0, y: 0 },
      { id: M22_CURRENT_NODE, x: 220, y: 0 },
      { id: "checks", x: 440, y: 0 },
      { id: "review", x: 660, y: 0 },
    ],
  },
};

// --- M38 fixture: decide/on_mismatch routing (ADR-103, engine 1.7.0) ---------
// TWO launchable projects, each carrying ONE Backlog task wired to an
// ALL-`cli` graph flow (no ai_coding/judge → background runFlow runs to a
// terminal state with NO supervisor session, only the GET /health gate). The
// e2e spec launches each from the board and asserts the routed run-detail:
//   • HAPPY (`e2e-m38-route`): a `cli` `classify` node writes
//     {"verdict":"bug"} to $MAISTER_OUTPUT_FILE, `decide:{from:"output.verdict"}`
//     routes to `fixit` (not `designit`). The run reaches Review; the timeline
//     ledger shows classify+fixit Succeeded and designit ABSENT; the P7 writer
//     leaves `<worktree>/.maister/run.json`.
//   • NEGATIVE (`e2e-m38-mismatch`): a `cli` `classify` node emits {"score":1}
//     (missing required `verdict`) with `output.result` but NO `on_mismatch` →
//     structured-output validation CONFIG-fails → run ends Failed, never
//     promotes.
// Both flows declare `output.result.schema: ./schemas/result.json`; the schema
// doc is written into each flow's installed_path so resolveOutputResultSchema
// reads it at runtime (the m26 fixture grammar: verdict string required, score
// number). The launch snapshots flow.enabledRevisionId → runs.flow_revision_id,
// so the runtime resolves the manifest + install dir from the flow_revisions
// row this fixture overrides.

const M38_ROUTE_SLUG = "e2e-m38-route";
const M38_MISMATCH_SLUG = "e2e-m38-mismatch";
const M38_ROUTE_TASK_TITLE = "Classify and route the change";
const M38_MISMATCH_TASK_TITLE = "Emit malformed structured output";
const M38_OUTPUT_SCHEMA_REL = "./schemas/result.json";

// The m26 structured-output schema doc (verdict required, score optional),
// written to each flow's install dir so the runtime resolver can read it.
const M38_RESULT_SCHEMA_DOC = {
  schemaVersion: 1,
  fields: [
    { name: "verdict", type: "string", required: true },
    { name: "score", type: "number" },
  ],
};

// Happy path: from:output routing. `classify` emits verdict "bug" → the
// allow-listed `bug` transition routes to `fixit`; `designit` never runs.
const M38_ROUTE_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Decide Route (e2e)",
  compat: { engine_min: "1.7.0" },
  nodes: [
    {
      id: "classify",
      type: "cli",
      action: {
        command: `echo '{"verdict":"bug","score":1}' > "$MAISTER_OUTPUT_FILE"`,
      },
      output: { result: { schema: M38_OUTPUT_SCHEMA_REL } },
      decide: { from: "output.verdict" },
      transitions: { bug: "fixit", feature: "designit" },
    },
    {
      id: "fixit",
      type: "cli",
      action: { command: "echo fixing" },
      transitions: { success: "done" },
    },
    {
      id: "designit",
      type: "cli",
      action: { command: "echo designing" },
      transitions: { success: "done" },
    },
  ],
};

// Negative path: malformed output (missing required `verdict`) with NO
// on_mismatch → structured-output validation CONFIG-fails → run ends Failed.
const M38_MISMATCH_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Mismatch Fail (e2e)",
  compat: { engine_min: "1.7.0" },
  nodes: [
    {
      id: "classify",
      type: "cli",
      action: {
        command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`,
      },
      output: { result: { schema: M38_OUTPUT_SCHEMA_REL } },
      transitions: { success: "done" },
    },
  ],
};

// --- M38 Flow Studio fixture: an authored DRAFT flow whose `classify` node
// declares `output.result` + a `decide.from` block, so selecting it in the
// Studio graph editor renders the new Routing panel (node-decide /
// node-decide-source / node-decide-path) populated. The editor reads the
// manifest from authored_capability_revisions.body — the schema file does NOT
// need to exist on disk (showRouting keys on `typeof result.schema === string`).
const M38_STUDIO_SLUG = "e2e-m38-studio";
const M38_STUDIO_NODE = "classify";

const M38_STUDIO_MANIFEST = {
  schemaVersion: 1,
  name: "M38 Decide Studio",
  compat: { engine_min: "1.7.0" },
  nodes: [
    {
      id: M38_STUDIO_NODE,
      type: "cli",
      action: {
        command: `echo '{"verdict":"bug"}' > "$MAISTER_OUTPUT_FILE"`,
      },
      output: { result: { schema: M38_OUTPUT_SCHEMA_REL } },
      decide: { from: "output.verdict" },
      transitions: { bug: "fixit", feature: "designit" },
    },
    {
      id: "fixit",
      type: "cli",
      action: { command: "echo fixing" },
      transitions: { success: "done" },
    },
    {
      id: "designit",
      type: "cli",
      action: { command: "echo designing" },
      transitions: { success: "done" },
    },
  ],
};

const M38_STUDIO_FLOW_YAML = `schemaVersion: 1
name: M38 Decide Studio
compat:
  engine_min: "1.7.0"
nodes:
  - id: ${M38_STUDIO_NODE}
    type: cli
    action:
      command: echo '{"verdict":"bug"}' > "$MAISTER_OUTPUT_FILE"
    output:
      result:
        schema: ${M38_OUTPUT_SCHEMA_REL}
    decide:
      from: output.verdict
    transitions:
      bug: fixit
      feature: designit
  - id: fixit
    type: cli
    action:
      command: echo fixing
    transitions:
      success: done
  - id: designit
    type: cli
    action:
      command: echo designing
    transitions:
      success: done
`;

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
  runnerId?: string;
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
  default_runner: ${args.runnerId ?? "claude-sonnet"}
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
    runner: ${args.runnerId ?? "claude-sonnet"}
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
  default_runner: claude-code
flows: []
`,
  );
}

async function seedPlatformRuntime(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM platform_runtime_settings WHERE id = 'singleton'`,
  );
  await pool.query(
    `DELETE FROM platform_acp_runners WHERE id = ANY($1::text[])`,
    [
      [
        PLATFORM_DEFAULT_RUNNER_ID,
        CODEX_RUNNER_ID,
        CCR_RUNNER_ID,
        NOT_READY_RUNNER_ID,
      ],
    ],
  );
  await pool.query(`DELETE FROM platform_router_sidecars WHERE id = $1`, [
    CCR_SIDECAR_ID,
  ]);

  await pool.query(
    `INSERT INTO platform_router_sidecars
       (id, kind, lifecycle, command_preset, config_path, base_url,
        healthcheck_url, auth_token_ref, readiness_status, readiness_reasons,
        enabled)
     VALUES ($1, 'ccr', 'managed', 'ccr_start', $2, $3, $4, $5, 'Ready',
        '[]'::jsonb, true)`,
    [
      CCR_SIDECAR_ID,
      "~/.claude-code-router/config.json",
      "http://127.0.0.1:3456",
      "http://127.0.0.1:3456/health",
      "env:MAISTER_CCR_AUTH_TOKEN",
    ],
  );
  // ADR-094: the readiness seeded here equals what reconcilePlatformRunners
  // derives from the stub diagnostics (claude + codex binaries available,
  // ZAI_API_KEY absent) — claude-code/codex-openai Ready, codex-zai-glm
  // NotReady. Specs that launch a run WITHOUT visiting /settings (the reconcile
  // only runs on the settings page) therefore see deterministic readiness; the
  // platform-acp-runners spec visits /settings, where the reconcile recomputes
  // the same verdicts (idempotent) over the dot-based UI.
  await pool.query(
    `INSERT INTO platform_acp_runners
       (id, adapter, capability_agent, model, provider, permission_policy,
        sidecar_id, readiness_status, readiness_reasons, enabled)
     VALUES
       ($1, 'claude', 'claude', 'claude-sonnet-4-6', $2::jsonb, 'default',
        null, 'Ready', '[]'::jsonb, true),
       ($3, 'codex', 'codex', 'gpt-5-codex', $4::jsonb, 'default',
        null, 'Ready', '[]'::jsonb, true),
       ($5, 'claude', 'claude', 'glm-5.1', $6::jsonb, 'default',
        $7, 'Ready', '[]'::jsonb, true),
       ($8, 'codex', 'codex', 'glm-5.1', $9::jsonb, 'default',
        null, 'NotReady', $10::jsonb, true)`,
    [
      PLATFORM_DEFAULT_RUNNER_ID,
      JSON.stringify({ kind: "anthropic" }),
      CODEX_RUNNER_ID,
      JSON.stringify({ kind: "openai" }),
      CCR_RUNNER_ID,
      JSON.stringify({ kind: "anthropic_compatible" }),
      CCR_SIDECAR_ID,
      NOT_READY_RUNNER_ID,
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: "env:ZAI_API_KEY",
        wireApi: "responses",
      }),
      JSON.stringify([
        "Codex OpenAI-compatible provider materialization is not verified",
      ]),
    ],
  );
  await pool.query(
    `INSERT INTO platform_runtime_settings (id, default_runner_id)
     VALUES ('singleton', $1)`,
    [PLATFORM_DEFAULT_RUNNER_ID],
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
    runner: randomUUID(),
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
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M11A_SLUG,
      "MAIster E2E",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif@v0.0.1`,
      JSON.stringify(M11A_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E review→rework", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1')`,
    [ids.run, ids.task, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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

async function seedM12EvidenceFixture(
  pool: Pool,
  userId: string,
): Promise<M12FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
    planAttempt: randomUUID(),
    implAttempt: randomUUID(),
    checksAttempt: randomUUID(),
    judgeAttempt: randomUUID(),
    reviewAttempt: randomUUID(),
    planSummary: randomUUID(),
    implDiff: randomUUID(),
    lintReport: randomUUID(),
    judgeVerdict: randomUUID(),
    gate: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-evidence`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M12_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M12_SLUG,
      "MAIster E2E M12 Evidence",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-m12@v0.0.1`,
      JSON.stringify(M12_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E evidence graph", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
    [ids.run, ids.task, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ids.workspace, ids.run, ids.project, M12_BRANCH, worktreePath, repoPath],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(M12_REVIEW_SCHEMA),
      "Review the implementation. Approve to ship, or request rework.",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  // Ledger: plan/implement/checks/judge Succeeded → review NeedsInput.
  const attempts: Array<[string, string, string, string]> = [
    [ids.planAttempt, "plan", "ai_coding", "Succeeded"],
    [ids.implAttempt, "implement", "ai_coding", "Succeeded"],
    [ids.checksAttempt, "checks", "check", "Succeeded"],
    [ids.judgeAttempt, "judge", "judge", "Succeeded"],
  ];

  for (const [id, nodeId, nodeType, status] of attempts) {
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at, ended_at)
       VALUES ($1, $2, $3, $4, 1, $5, now(), now())`,
      [id, ids.run, nodeId, nodeType, status],
    );
  }
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.reviewAttempt, ids.run],
  );

  // Artifacts (validity current, producer runner). impl-diff uses an inline
  // locator so the payload route returns text without touching git.
  const artifacts: Array<[string, string, string, string, unknown, unknown]> = [
    [
      ids.planSummary,
      ids.planAttempt,
      "plan",
      "plan-summary",
      "human_note",
      { kind: "inline", text: "Plan: implement feature X in three steps." },
    ],
    [
      ids.implDiff,
      ids.implAttempt,
      "implement",
      "impl-diff",
      "diff",
      {
        kind: "inline",
        text: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n",
      },
    ],
    [
      ids.lintReport,
      ids.checksAttempt,
      "checks",
      "lint-report",
      "lint_report",
      { kind: "inline", text: "0 problems (0 errors, 0 warnings)" },
    ],
    [
      ids.judgeVerdict,
      ids.judgeAttempt,
      "judge",
      "judge-verdict",
      "ai_judgment",
      { kind: "inline", text: '{"verdict":"pass","confidence":0.9}' },
    ],
  ];

  for (const [
    id,
    nodeAttemptId,
    nodeId,
    artifactDefId,
    kind,
    locator,
  ] of artifacts) {
    const requiredFor =
      artifactDefId === "impl-diff" ? ["review", "merge"] : null;

    await pool.query(
      `INSERT INTO artifact_instances
         (id, run_id, node_attempt_id, node_id, attempt, artifact_def_id, kind,
          producer, locator, validity, required_for, visibility, retention, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 'runner', $7, 'current', $8, 'internal', 'run', now())`,
      [
        id,
        ids.run,
        nodeAttemptId,
        nodeId,
        artifactDefId,
        kind,
        JSON.stringify(locator),
        requiredFor ? JSON.stringify(requiredFor) : null,
      ],
    );
  }

  // A PASSED blocking artifact_required gate on the review attempt.
  await pool.query(
    `INSERT INTO gate_results
       (id, run_id, node_attempt_id, gate_id, kind, mode, status, input_artifact_refs, created_at, ended_at)
     VALUES ($1, $2, $3, 'impl-diff-required', 'artifact_required', 'blocking', 'passed', $4, now(), now())`,
    [ids.gate, ids.run, ids.reviewAttempt, JSON.stringify(["impl-diff"])],
  );

  return {
    runId: ids.run,
    hitlRequestId: ids.hitl,
    projectSlug: M12_SLUG,
    branch: M12_BRANCH,
    worktreePath,
    implDiffArtifactId: ids.implDiff,
    gateResultId: ids.gate,
  };
}

async function seedM11bFixture(
  pool: Pool,
  userId: string,
): Promise<FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
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
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M11B_SLUG,
      "MAIster E2E Takeover",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-takeover@v0.0.1`,
      JSON.stringify(M11B_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E manual takeover", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', $5, 'v0.0.1', now())`,
    [ids.run, ids.task, ids.project, ids.flow, M11B_REVIEW_NODE],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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

// Parent repo with a base commit (README) + the run branch worktree carrying
// ONE committed change: src/greeting.ts written from RC_FILE_LINES — the same
// array the seeded threads' line_content comes from, so inline placement
// byte-matches by construction. Returns the base SHA for workspaces.base_commit.
async function provisionReviewCommentsRepo(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<{ baseCommit: string }> {
  mkdirSync(path.dirname(repoPath), { recursive: true });
  await createGitRepo(repoPath);

  const { stdout: baseSha } = await execFileAsync("git", [
    "-C",
    repoPath,
    "rev-parse",
    "HEAD",
  ]);
  const baseCommit = baseSha.trim();

  await execFileAsync("git", [
    "-C",
    repoPath,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);
  mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  writeFileSync(
    path.join(worktreePath, RC_FILE_PATH),
    `${RC_FILE_LINES.join("\n")}\n`,
    "utf8",
  );
  await execFileAsync("git", ["-C", worktreePath, "add", RC_FILE_PATH]);
  await execFileAsync("git", [
    "-C",
    worktreePath,
    "commit",
    "-m",
    "add greeting module",
  ]);

  return { baseCommit };
}

async function seedReviewCommentsFixture(
  pool: Pool,
  user: UserFixture,
): Promise<ReviewCommentsFixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitlPrior: randomUUID(),
    hitl: randomUUID(),
    member: randomUUID(),
    implAttempt1: randomUUID(),
    reviewAttempt1: randomUUID(),
    implAttempt2: randomUUID(),
    reviewAttempt2: randomUUID(),
    threadInline: randomUUID(),
    threadInlineReply: randomUUID(),
    threadSecond: randomUUID(),
    threadOutdated: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-review-comments`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [RC_SLUG]);

  const { baseCommit } = await provisionReviewCommentsRepo(
    repoPath,
    worktreePath,
    RC_BRANCH,
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      RC_SLUG,
      "MAIster E2E Review Comments",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-review-comments@v0.0.1`,
      JSON.stringify(RC_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E review comments", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
    [ids.run, ids.task, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces
       (id, run_id, project_id, branch, worktree_path, parent_repo_path,
        base_branch, base_commit, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, 'main')`,
    [
      ids.workspace,
      ids.run,
      ids.project,
      RC_BRANCH,
      worktreePath,
      repoPath,
      baseCommit,
    ],
  );

  // Ledger: visit 1 (implement → review, responded rework) → visit 2
  // (implement attempt 2 → review attempt 2 parked NeedsInput) — consistent
  // with the pending schema's gateAttempt = 2.
  const attempts: Array<[string, string, string, number, string]> = [
    [ids.implAttempt1, "implement", "ai_coding", 1, "Succeeded"],
    [ids.reviewAttempt1, "review", "human", 1, "Succeeded"],
    [ids.implAttempt2, "implement", "ai_coding", 2, "Succeeded"],
  ];

  for (const [id, nodeId, nodeType, attempt, status] of attempts) {
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
      [id, ids.run, nodeId, nodeType, attempt, status],
    );
  }
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 2, 'NeedsInput', now())`,
    [ids.reviewAttempt2, ids.run],
  );

  // Visit 1's CLOSED review gate (the seeded threads' authoring visit) + the
  // CURRENT pending gate whose schema carries maxLoops/gateAttempt (D5).
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, response, decision, workspace_policy, rework_target, responded_at)
     VALUES ($1, $2, 'review', 'human', $3, $4, $5, 'rework', 'keep', 'implement', now())`,
    [
      ids.hitlPrior,
      ids.run,
      JSON.stringify({ ...RC_REVIEW_SCHEMA, gateAttempt: 1 }),
      "Review the implementation. Approve to ship, or request rework.",
      JSON.stringify({
        decision: "rework",
        comments: "First pass: see the inline comments.",
        workspacePolicy: "keep",
      }),
    ],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(RC_REVIEW_SCHEMA),
      "Re-review the implementation. Approve to ship, or request rework.",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, user.id],
  );

  // Seeded threads (all authored on visit 1, FK'd to the responded gate):
  //   • inline root at new:2 + a reply — line_content byte-matches the diff;
  //   • inline root at new:5 — byte-matches (the spec resolves this one);
  //   • root at new:3 whose stored content mismatches → placement "outdated".
  const inline = {
    line: 2,
    body: "Use a template literal here.",
    reply: "Agreed — will fix in the next pass.",
  };
  const second = { line: 5, body: "Version constant looks good." };
  const outdated = {
    line: 3,
    body: "This brace placement is wrong.",
    staleContent: RC_STALE_LINE_CONTENT,
  };

  const roots: Array<[string, number, string, string]> = [
    [
      ids.threadInline,
      inline.line,
      RC_FILE_LINES[inline.line - 1],
      inline.body,
    ],
    [
      ids.threadSecond,
      second.line,
      RC_FILE_LINES[second.line - 1],
      second.body,
    ],
    [ids.threadOutdated, outdated.line, RC_STALE_LINE_CONTENT, outdated.body],
  ];

  for (const [id, line, lineContent, body] of roots) {
    await pool.query(
      `INSERT INTO review_comments
         (id, run_id, hitl_request_id, node_id, gate_attempt, author_user_id,
          author_label, file_path, side, line, line_content, body, status)
       VALUES ($1, $2, $3, 'review', 1, $4, $5, $6, 'new', $7, $8, $9, 'open')`,
      [
        id,
        ids.run,
        ids.hitlPrior,
        user.id,
        user.name,
        RC_FILE_PATH,
        line,
        lineContent,
        body,
      ],
    );
  }
  await pool.query(
    `INSERT INTO review_comments
       (id, run_id, hitl_request_id, node_id, gate_attempt, parent_id,
        author_user_id, author_label, body, status)
     VALUES ($1, $2, $3, 'review', 1, $4, $5, $6, $7, 'open')`,
    [
      ids.threadInlineReply,
      ids.run,
      ids.hitlPrior,
      ids.threadInline,
      user.id,
      user.name,
      inline.reply,
    ],
  );

  return {
    runId: ids.run,
    hitlRequestId: ids.hitl,
    projectSlug: RC_SLUG,
    branch: RC_BRANCH,
    worktreePath,
    filePath: RC_FILE_PATH,
    inline,
    second,
    outdated,
    composeLine: 1,
    maxLoops: RC_MAX_LOOPS,
    gateAttempt: RC_GATE_ATTEMPT,
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
    defaultRunnerId?: string | null;
    executor?: {
      refId: string;
      agent: SeedAdapterId;
      model: string;
      router?: "ccr";
    };
  },
): Promise<ProjectFixture> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
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
    runnerId: executor.refId,
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
    `INSERT INTO projects
       (id, slug, name, repo_path, main_branch, branch_prefix,
        maister_yaml_path, default_runner_id, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, $6, $7, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      args.slug,
      args.projectName,
      args.repoPath,
      args.branchPrefix ?? "maister/",
      path.join(args.repoPath, "maister.yaml"),
      args.defaultRunnerId ?? null,
    ],
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
  // Respect an explicitly requested default runner (e.g. the scratch fixture
  // pins codex-openai); only fall back to the per-project Ready runner.
  await pool.query(`UPDATE projects SET default_runner_id = $1 WHERE id = $2`, [
    args.defaultRunnerId ?? ids.runner,
    ids.project,
  ]);
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
    runnerId: args.defaultRunnerId ?? PLATFORM_DEFAULT_RUNNER_ID,
    flowId: ids.flow,
  };

  if (!args.task) {
    return fixture;
  }

  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, $6, $7)`,
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
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
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
       (id, task_id, project_id, flow_id, status, current_step_id,
        flow_version, flow_revision, flow_revision_id, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review',
        'v0.0.1', $5, $6, now())`,
    [ids.run, hitlTaskId, ids.project, ids.flow, ids.revision, ids.revision],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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
    runner: randomUUID(),
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
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M11C_VISIBLE_SLUG,
      "MAIster E2E M11c Visible",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-m11c-visible@v0.0.1`,
      JSON.stringify(M11C_VISIBLE_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E settings visible", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1')`,
    [ids.run, ids.task, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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
    runner: randomUUID(),
    flow: randomUUID(),
    revision: randomUUID(),
    task: randomUUID(),
    member: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const installedPath = `/tmp/maister-e2e/flows/aif-m11c-refuse@v0.0.1`;

  // The ADR-087 launch dialog loads /api/runs/launch-options, which lists the
  // project repo's branches — the refusal path now needs a REAL git repo even
  // though the launch itself is refused before any worktree op.
  await createGitRepo(repoPath);

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M11C_REFUSE_SLUG]);
  // flow_revisions is project-independent (keyed by flow_ref_id + resolved
  // revision); delete the prior row by that unique key for idempotency.
  await pool.query(
    `DELETE FROM flow_revisions WHERE flow_ref_id = 'aif-m11c-refuse'`,
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M11C_REFUSE_SLUG,
      "MAIster E2E M11c Refuse",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
  // M14 capability registry: register the `github` mcp the manifest's `implement`
  // node declares in `settings.mcps`. Without it the M14 capability-ref check
  // (firstUnknownCapabilityRef) rejects the launch with CONFIG "unknown mcp
  // capability ref github" BEFORE the M11c settings-enforcement gate runs — so
  // the launch never reaches the gate this fixture exists to exercise (`mcps:
  // strict` refusal). agents `[]` + the column defaults keep the row minimal.
  await pool.query(
    `INSERT INTO capability_records
       (id, project_id, capability_ref_id, kind, label, source, agents)
     VALUES ($1, $2, 'github', 'mcp', 'GitHub', 'project', '[]'::jsonb)`,
    [randomUUID(), ids.project],
  );
  // The enabled revision the launch path resolves the manifest from. Installed +
  // setup done + supported schema + engine-compatible so launch reaches the
  // settings-enforcement gate rather than failing an earlier precondition.
  // The enabled revision carries default_runner_id (platformFlowDefault tier)
  // so the launch resolves a runner and reaches the settings-enforcement gate
  // rather than throwing EXECUTOR_UNAVAILABLE first.
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision, manifest_digest,
        manifest, schema_version, engine_min, installed_path, setup_status, package_status,
        default_runner_id)
     VALUES ($1, 'aif-m11c-refuse', $2, 'v0.0.1', 'rev-m11c-refuse', 'sha-m11c-refuse',
        $3, 1, '1.1.0', $4, 'done', 'Installed', $5)`,
    [
      ids.revision,
      "github.com/maister/maister-flow-aif",
      JSON.stringify(M11C_REFUSE_MANIFEST),
      installedPath,
      ids.runner,
    ],
  );
  // The project flow row: Enabled + trusted, pointing at the strict revision.
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision, installed_path, manifest,
        schema_version, enabled_revision_id, enablement_state, trust_status)
     VALUES ($1, $2, 'aif-m11c-refuse', $3, 'v0.0.1', 'rev-m11c-refuse', $4, $5, 1,
        $6, 'Enabled', 'trusted')`,
    [
      ids.flow,
      ids.project,
      "github.com/maister/maister-flow-aif",
      installedPath,
      JSON.stringify(M11C_REFUSE_MANIFEST),
      ids.revision,
    ],
  );
  // A launchable Backlog task → the board shows a Launch button on its card.
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'Backlog', 'Backlog')`,
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
  notRecoverableRunId: string;
  notRecoverableBranch: string;
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
    runner: randomUUID(),
    flow: randomUUID(),
    member: randomUUID(),
    crashedTask: randomUUID(),
    crashedRun: randomUUID(),
    crashedWorkspace: randomUUID(),
    crashedAttempt: randomUUID(),
    notRecoverableTask: randomUUID(),
    notRecoverableRun: randomUUID(),
    notRecoverableWorkspace: randomUUID(),
    notRecoverableAttempt: randomUUID(),
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
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M19_SLUG,
      "MAIster E2E M19",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
  await pool.query(`UPDATE projects SET default_runner_id = $1 WHERE id = $2`, [
    ids.runner,
    ids.project,
  ]);
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
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.crashedTask,
      ids.project,
      "E2E crashed recoverable",
      "do the thing",
      ids.flow,
    ],
  );
  // Realistic reconcile-crash shape: current_step_id is nulled, the node id is
  // retained in resume_target_step_id (ADR-034). Recover resolves ai_coding +
  // acp_session_id → resume-agent → recoverable.
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, resume_target_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, 'Crashed', $5, 'v0.0.1', now(), now())`,
    [ids.crashedRun, ids.crashedTask, ids.project, ids.flow, M19_AGENT_NODE],
  );
  await seedDefaultRunSession(pool, {
    acpSessionId: "acp-m19-crashed",
    capabilityAgent: "claude",
    runId: ids.crashedRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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

  // (1b) Non-recoverable Crashed flow run: an agent node with NO acp_session_id
  // → resolves discard-only → recoverable:false. Recover is hidden, but Discard
  // MUST still render so the run can enter the GC countdown (the F1 guard). Same
  // realistic crash shape: current_step_id nulled, node retained in
  // resume_target_step_id.
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.notRecoverableTask,
      ids.project,
      "E2E crashed not-recoverable",
      "do the thing",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, resume_target_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, 'Crashed', $5, 'v0.0.1', now(), now())`,
    [
      ids.notRecoverableRun,
      ids.notRecoverableTask,
      ids.project,
      ids.flow,
      M19_AGENT_NODE,
    ],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.notRecoverableRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status)
     VALUES ($1, $2, $3, 'ai_coding', 1, 'Crashed')`,
    [ids.notRecoverableAttempt, ids.notRecoverableRun, M19_AGENT_NODE],
  );
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.notRecoverableWorkspace,
      ids.notRecoverableRun,
      ids.project,
      M19_NOT_RECOVERABLE_BRANCH,
      `${repoPath}/.worktrees/m19-not-recoverable`,
      repoPath,
    ],
  );

  // (2) Abandoned run, workspace removal inside the warning window.
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'Abandoned', 'Backlog')`,
    [ids.warningTask, ids.project, "E2E ttl warning", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, 'Abandoned', $5, 'v0.0.1', now(), now())`,
    [ids.warningRun, ids.warningTask, ids.project, ids.flow, M19_AGENT_NODE],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.warningRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'Abandoned', 'Backlog')`,
    [ids.dueTask, ids.project, "E2E ttl due", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at, ended_at)
     VALUES ($1, $2, $3, $4, 'Abandoned', $5, 'v0.0.1', now(), now())`,
    [ids.dueRun, ids.dueTask, ids.project, ids.flow, M19_AGENT_NODE],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.dueRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
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
    notRecoverableRunId: ids.notRecoverableRun,
    notRecoverableBranch: M19_NOT_RECOVERABLE_BRANCH,
    warningRunId: ids.warningRun,
    warningBranch: M19_WARNING_BRANCH,
    dueRunId: ids.dueRun,
    dueBranch: M19_DUE_BRANCH,
  };
}

async function seedM15Fixture(
  pool: Pool,
  userId: string,
): Promise<M15FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    failedTask: randomUUID(),
    failedRun: randomUUID(),
    failedWorkspace: randomUUID(),
    failedHitl: randomUUID(),
    failedImplAttempt: randomUUID(),
    failedReviewAttempt: randomUUID(),
    failedGate: randomUUID(),
    overriddenTask: randomUUID(),
    overriddenRun: randomUUID(),
    overriddenWorkspace: randomUUID(),
    overriddenHitl: randomUUID(),
    overriddenImplAttempt: randomUUID(),
    overriddenReviewAttempt: randomUUID(),
    overriddenGate: randomUUID(),
    member: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const failedWorktreePath = `${repoPath}/.worktrees/e2e-m15-failed`;
  const overriddenWorktreePath = `${repoPath}/.worktrees/e2e-m15-overridden`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M15_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M15_SLUG,
      "MAIster E2E M15 Readiness",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-readiness@v0.0.1`,
      JSON.stringify(M15_MANIFEST),
    ],
  );

  // Fixture 1: A run in Review with a BLOCKING gate seeded `failed`.
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.failedTask,
      ids.project,
      "E2E readiness failed",
      "do the thing",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'Review', 'review', 'v0.0.1', now())`,
    [ids.failedRun, ids.failedTask, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.failedRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.failedWorkspace,
      ids.failedRun,
      ids.project,
      M15_FAILED_BRANCH,
      failedWorktreePath,
      repoPath,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.failedImplAttempt, ids.failedRun],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.failedReviewAttempt, ids.failedRun],
  );
  await pool.query(
    `INSERT INTO gate_results (id, run_id, node_attempt_id, gate_id, kind, mode, status, created_at, ended_at)
     VALUES ($1, $2, $3, $4, 'external_check', 'blocking', 'failed', now(), now())`,
    [ids.failedGate, ids.failedRun, ids.failedReviewAttempt, M15_GATE_ID],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.failedHitl,
      ids.failedRun,
      JSON.stringify(M15_REVIEW_SCHEMA),
      "Review the implementation.",
    ],
  );

  // Fixture 2: A run in Review with the SAME gate OVERRIDDEN.
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.overriddenTask,
      ids.project,
      "E2E readiness overridden",
      "do the thing",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'Review', 'review', 'v0.0.1', now())`,
    [ids.overriddenRun, ids.overriddenTask, ids.project, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.overriddenRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.overriddenWorkspace,
      ids.overriddenRun,
      ids.project,
      M15_OVERRIDDEN_BRANCH,
      overriddenWorktreePath,
      repoPath,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.overriddenImplAttempt, ids.overriddenRun],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.overriddenReviewAttempt, ids.overriddenRun],
  );
  await pool.query(
    `INSERT INTO gate_results (id, run_id, node_attempt_id, gate_id, kind, mode, status, created_at, ended_at)
     VALUES ($1, $2, $3, $4, 'external_check', 'blocking', 'overridden', now(), now())`,
    [
      ids.overriddenGate,
      ids.overriddenRun,
      ids.overriddenReviewAttempt,
      M15_GATE_ID,
    ],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.overriddenHitl,
      ids.overriddenRun,
      JSON.stringify(M15_REVIEW_SCHEMA),
      "Review the implementation.",
    ],
  );

  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  return {
    projectSlug: M15_SLUG,
    failedRunId: ids.failedRun,
    failedHitlRequestId: ids.failedHitl,
    overriddenRunId: ids.overriddenRun,
    overriddenHitlRequestId: ids.overriddenHitl,
    gateId: M15_GATE_ID,
  };
}

type M16FixtureRecord = ProjectFixture & {
  launchTaskId: string;
  runId: string;
  hitlRequestId: string;
  gateId: string;
};

async function seedM16Fixture(
  pool: Pool,
  userId: string,
): Promise<M16FixtureRecord> {
  // Reuse the launchable scaffolding (real git repo, enabled flow revision,
  // Backlog task) so the token-auth task-create + run-launch reach 201/202.
  const base = await seedLaunchableProjectFixture(pool, {
    slug: M16_SLUG,
    projectName: "E2E M16 External Ops",
    userId,
    repoPath: path.join(RUNTIME_ROOT, "repos", M16_SLUG),
    task: {
      title: "M16 backlog launch",
      prompt: "Exercise the external-operations launch path.",
      status: "Backlog",
      stage: "Backlog",
    },
  });

  // The parked review run lives on a SECOND flow row whose manifest carries the
  // external_check gate (so resolveGateExternalConfig reads its `external`
  // block). No on-disk worktree — the gate/readiness/evidence steps are pure
  // DB reads + the report endpoint, supervisor-independent.
  const ids = {
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    implAttempt: randomUUID(),
    reviewAttempt: randomUUID(),
    gate: randomUUID(),
  };
  const repoPath = base.repoPath;
  const worktreePath = `${repoPath}/.worktrees/e2e-m16-review`;

  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif-external', $3, 'v0.0.1', $4, $5, 1)`,
    [
      ids.flow,
      base.projectId,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-external@v0.0.1`,
      JSON.stringify(M16_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, base.projectId, "M16 external review", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
    [ids.run, ids.task, base.projectId, ids.flow],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: base.runnerId,
    runnerResolutionTier: "projectDefault",
    runnerSnapshot: {
      id: base.runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      providerKind: "anthropic",
      permissionPolicy: "default",
      sidecar: null,
      sidecarId: null,
    },
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.workspace,
      ids.run,
      base.projectId,
      M16_REVIEW_BRANCH,
      worktreePath,
      repoPath,
    ],
  );

  // Ledger: implement Succeeded → review NeedsInput. The external_check gate
  // hangs off the LIVE review attempt (latest attempt per node), so readiness
  // and the report endpoint both resolve it.
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.implAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.reviewAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO gate_results (id, run_id, node_attempt_id, gate_id, kind, mode, status)
     VALUES ($1, $2, $3, $4, 'external_check', 'blocking', 'pending')`,
    [ids.gate, ids.run, ids.reviewAttempt, M16_GATE_ID],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, $4)`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(M16_REVIEW_SCHEMA),
      "Review the implementation once the external check passes.",
    ],
  );

  return {
    ...base,
    launchTaskId: base.taskId as string,
    flowId: ids.flow,
    runId: ids.run,
    hitlRequestId: ids.hitl,
    gateId: M16_GATE_ID,
  };
}

// --- M17 Fixture type and seeding function --------------------------------

type M17FixtureRecord = {
  project1Slug: string;
  project1Id: string;
  project1RunId: string;
  project1HitlId: string;
  project1Branch: string;
  project2Slug: string;
  project2Id: string;
  project2RunId: string;
  project2HitlId: string;
  project2Branch: string;
};

type BudgetForkFixtureRecord = {
  projectSlug: string;
  projectId: string;
  runId: string;
  hitlRequestId: string;
  taskTitle: string;
};

const BUDGET_FORK_SLUG = "e2e-budget-fork";
const BUDGET_FORK_BRANCH = "maister/e2e-budget-fork";
const BUDGET_FORK_TASK_TITLE = "Budget Fork Decision";
const BUDGET_FORK_SCHEMA = {
  kind: "budget_breach",
  scope: "run",
  meter: "tokens",
  current: 1200,
  limit: 1000,
  decisions: ["raise", "abandon"],
};

async function seedM17Fixture(
  pool: Pool,
  _userId: string,
): Promise<M17FixtureRecord> {
  const ids = {
    project1: randomUUID(),
    executor1: randomUUID(),
    flow1: randomUUID(),
    task1: randomUUID(),
    run1: randomUUID(),
    workspace1: randomUUID(),
    hitl1: randomUUID(),
    implAttempt1: randomUUID(),
    reviewAttempt1: randomUUID(),
    project2: randomUUID(),
    executor2: randomUUID(),
    flow2: randomUUID(),
    task2: randomUUID(),
    run2: randomUUID(),
    workspace2: randomUUID(),
    hitl2: randomUUID(),
    implAttempt2: randomUUID(),
    reviewAttempt2: randomUUID(),
  };

  const repoPath1 = `/tmp/maister-e2e/${ids.project1}`;
  const repoPath2 = `/tmp/maister-e2e/${ids.project2}`;
  const worktreePath1 = `${repoPath1}/.worktrees/e2e-m17-proj1`;
  const worktreePath2 = `${repoPath2}/.worktrees/e2e-m17-proj2`;

  // Clean up any prior M17 state
  await pool.query(`DELETE FROM projects WHERE slug IN ($1, $2)`, [
    M17_PROJECT1_SLUG,
    M17_PROJECT2_SLUG,
  ]);

  // --- Project 1: permission + human_review with criticality ---
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project1,
      M17_PROJECT1_SLUG,
      "MAIster E2E M17 Project 1",
      repoPath1,
      `${repoPath1}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
    [
      ids.flow1,
      ids.project1,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-m17@v0.0.1`,
      JSON.stringify(M17_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.task1,
      ids.project1,
      "M17 Project 1 Review",
      "Review and approve the implementation",
      ids.flow1,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
    [ids.run1, ids.task1, ids.project1, ids.flow1],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run1,
    runnerId: PLATFORM_DEFAULT_RUNNER_ID,
    runnerSnapshot: e2eClaudeRunnerSnapshot(PLATFORM_DEFAULT_RUNNER_ID),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.workspace1,
      ids.run1,
      ids.project1,
      M17_BRANCH1,
      worktreePath1,
      repoPath1,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.implAttempt1, ids.run1],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.reviewAttempt1, ids.run1],
  );
  // Human review with criticality "high"
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality)
     VALUES ($1, $2, 'review', 'human_review', $3, $4, 'high')`,
    [
      ids.hitl1,
      ids.run1,
      JSON.stringify(M17_REVIEW_SCHEMA),
      "Review the implementation for code quality and correctness.",
    ],
  );

  // --- Project 2: human_review with on_reject send-back schema ---
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project2,
      M17_PROJECT2_SLUG,
      "MAIster E2E M17 Project 2",
      repoPath2,
      `${repoPath2}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
    [
      ids.flow2,
      ids.project2,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-m17-proj2@v0.0.1`,
      JSON.stringify(M17_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.task2,
      ids.project2,
      "M17 Project 2 Review",
      "Review and decide on the feature",
      ids.flow2,
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
    [ids.run2, ids.task2, ids.project2, ids.flow2],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run2,
    runnerId: PLATFORM_DEFAULT_RUNNER_ID,
    runnerSnapshot: e2eClaudeRunnerSnapshot(PLATFORM_DEFAULT_RUNNER_ID),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.workspace2,
      ids.run2,
      ids.project2,
      M17_BRANCH2,
      worktreePath2,
      repoPath2,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.implAttempt2, ids.run2],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.reviewAttempt2, ids.run2],
  );
  // Human review with medium criticality and on_reject schema for send-back
  const schemaWithOnReject = {
    ...M17_REVIEW_SCHEMA,
    onReject: {
      goto_step: "implement",
      commentsVar: "review_comments",
    },
  };

  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality)
     VALUES ($1, $2, 'review', 'human_review', $3, $4, 'medium')`,
    [
      ids.hitl2,
      ids.run2,
      JSON.stringify(schemaWithOnReject),
      "Review the feature design and provide feedback.",
    ],
  );

  return {
    project1Slug: M17_PROJECT1_SLUG,
    project1Id: ids.project1,
    project1RunId: ids.run1,
    project1HitlId: ids.hitl1,
    project1Branch: M17_BRANCH1,
    project2Slug: M17_PROJECT2_SLUG,
    project2Id: ids.project2,
    project2RunId: ids.run2,
    project2HitlId: ids.hitl2,
    project2Branch: M17_BRANCH2,
  };
}

async function seedBudgetForkFixture(
  pool: Pool,
  _userId: string,
): Promise<BudgetForkFixtureRecord> {
  const ids = {
    project: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    implAttempt: randomUUID(),
    reviewAttempt: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-budget-fork`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [BUDGET_FORK_SLUG]);
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      BUDGET_FORK_SLUG,
      "MAIster E2E Budget Fork",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
    [
      ids.flow,
      ids.project,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-budget-fork@v0.0.1`,
      JSON.stringify(M17_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [
      ids.task,
      ids.project,
      BUDGET_FORK_TASK_TITLE,
      "Decide how to handle a budget breach",
      ids.flow,
    ],
  );
  await pool.query(
    `INSERT INTO runs
       (id, task_id, project_id, flow_id, status, current_step_id, flow_version,
        execution_policy, budget_state, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', $5, $6, now() - interval '17 minutes')`,
    [
      ids.run,
      ids.task,
      ids.project,
      ids.flow,
      JSON.stringify({
        preset: "supervised",
        overrides: {
          budget: {
            run: {
              maxTokens: 1000,
              consecutiveFailures: 3,
              wallClockMinutes: 60,
            },
          },
          onBudgetBreach: "escalate",
        },
      }),
      JSON.stringify({ notified: { run: "escalate" }, ceilingOverride: {} }),
    ],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: PLATFORM_DEFAULT_RUNNER_ID,
    runnerSnapshot: e2eClaudeRunnerSnapshot(PLATFORM_DEFAULT_RUNNER_ID),
  });
  await pool.query(
    `INSERT INTO workspaces
       (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', 'maister/e2e-budget-target')`,
    [
      ids.workspace,
      ids.run,
      ids.project,
      BUDGET_FORK_BRANCH,
      worktreePath,
      repoPath,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.implAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.reviewAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality)
     VALUES ($1, $2, 'review', 'budget_breach', $3, $4, 'high')`,
    [
      ids.hitl,
      ids.run,
      JSON.stringify(BUDGET_FORK_SCHEMA),
      "Budget exceeded; choose how to continue.",
    ],
  );

  return {
    projectSlug: BUDGET_FORK_SLUG,
    projectId: ids.project,
    runId: ids.run,
    hitlRequestId: ids.hitl,
    taskTitle: BUDGET_FORK_TASK_TITLE,
  };
}

// --- M40 Fixture (guardrail hooks) ---------------------------------------
// One project, two NeedsInput flow runs each parked on a `hook_trip` HITL: a
// `repetition` trip (carries an offending toolCall, drives the render + abort
// assertions) and a `no_progress` trip (no toolCall, drives the resume route
// assertion). The web e2e supervisor stub cannot DYNAMICALLY trip a guardrail
// (no tool-call scripting — that lives in supervisor integration tests), so the
// trip state is seeded directly, mirroring how M17 seeds a `human_review` HITL.
const M40_PROJECT_SLUG = "e2e-m40-guardrail";
const M40_BRANCH_REPETITION = "maister/e2e-m40-repetition";
const M40_BRANCH_NOPROGRESS = "maister/e2e-m40-no-progress";
const M40_REPETITION_TITLE = "M40 Repetition trip";
const M40_NOPROGRESS_TITLE = "M40 No-progress trip";

// A flow whose ai_coding node declares `hooks` (engine_min >= 1.8.0 per ADR-108
// D6). Mirrors M17_MANIFEST's compiling shape; the trip is parked on `implement`.
const M40_MANIFEST = {
  schemaVersion: 1,
  name: "Guardrail hooks (e2e)",
  compat: { engine_min: "1.8.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      prompt: "implement {{ task.prompt }}",
      settings: {
        hooks: { repetition: { max: 5 }, noProgress: { maxTurns: 15 } },
      },
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

type M40FixtureRecord = {
  projectSlug: string;
  projectId: string;
  repetitionRunId: string;
  repetitionHitlId: string;
  repetitionTaskTitle: string;
  noProgressRunId: string;
  noProgressHitlId: string;
  noProgressTaskTitle: string;
};

async function seedM40HookTripRun(
  pool: Pool,
  projectId: string,
  flowId: string,
  branch: string,
  taskTitle: string,
  schema: Record<string, unknown>,
  prompt: string,
): Promise<{ runId: string; hitlId: string }> {
  const ids = {
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    hitl: randomUUID(),
    implAttempt: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${projectId}`;
  const worktreePath = `${repoPath}/.worktrees/${branch.split("/").pop()}`;

  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, projectId, taskTitle, "Loop on a boring task", flowId],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'NeedsInput', 'implement', 'v0.0.1', now())`,
    [ids.run, ids.task, projectId, flowId],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: PLATFORM_DEFAULT_RUNNER_ID,
    runnerSnapshot: e2eClaudeRunnerSnapshot(PLATFORM_DEFAULT_RUNNER_ID),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ids.workspace, ids.run, projectId, branch, worktreePath, repoPath],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'NeedsInput', now())`,
    [ids.implAttempt, ids.run],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'implement', 'hook_trip', $3, $4)`,
    [ids.hitl, ids.run, JSON.stringify(schema), prompt],
  );

  return { runId: ids.run, hitlId: ids.hitl };
}

async function seedM40Fixture(
  pool: Pool,
  _userId: string,
): Promise<M40FixtureRecord> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const repoPath = `/tmp/maister-e2e/${projectId}`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M40_PROJECT_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      projectId,
      M40_PROJECT_SLUG,
      "MAIster E2E M40 Guardrail",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     VALUES ($1, $2, 'aif', $3, 'v0.0.1', $4, $5, 1)`,
    [
      flowId,
      projectId,
      "github.com/maister/maister-flow-aif",
      `/tmp/maister-e2e/flows/aif-m40@v0.0.1`,
      JSON.stringify(M40_MANIFEST),
    ],
  );

  const repetition = await seedM40HookTripRun(
    pool,
    projectId,
    flowId,
    M40_BRANCH_REPETITION,
    M40_REPETITION_TITLE,
    {
      kind: "hook_trip",
      rule: "repetition",
      decisions: ["resume", "abort"],
      toolCall: { title: "Edit src/app.ts" },
    },
    'Guardrail "repetition" tripped: the agent repeated the same tool call too many times (last tool: Edit src/app.ts). Resume the run or abort.',
  );
  const noProgress = await seedM40HookTripRun(
    pool,
    projectId,
    flowId,
    M40_BRANCH_NOPROGRESS,
    M40_NOPROGRESS_TITLE,
    {
      kind: "hook_trip",
      rule: "no_progress",
      decisions: ["resume", "abort"],
    },
    'Guardrail "no_progress" tripped: the agent made no progress for too many turns. Resume the run or abort.',
  );

  return {
    projectSlug: M40_PROJECT_SLUG,
    projectId,
    repetitionRunId: repetition.runId,
    repetitionHitlId: repetition.hitlId,
    repetitionTaskTitle: M40_REPETITION_TITLE,
    noProgressRunId: noProgress.runId,
    noProgressHitlId: noProgress.hitlId,
    noProgressTaskTitle: M40_NOPROGRESS_TITLE,
  };
}

// The M18 fixture carries the three Review run ids (one per promotion scenario)
// plus the target branch + the pre-seeded PR display fields, so the e2e spec can
// navigate each run-detail page and assert the promote / conflict / PR-display
// surfaces deterministically.
type M18FixtureRecord = {
  projectSlug: string;
  repoPath: string;
  targetBranch: string;
  mergeRunId: string;
  mergeBranch: string;
  conflictRunId: string;
  conflictBranch: string;
  prRunId: string;
  prBranch: string;
  prUrl: string;
  prNumber: number;
};

type M27FixtureRecord = {
  projectSlug: string;
  repoPath: string;
  flowRunId: string;
  scratchRunId: string;
  flowBranch: string;
  scratchBranch: string;
};

// Build one run-branch worktree per scenario, off the `release` target, carrying
// a committed change. The base commit = the `release` HEAD the run branched from
// (so `diffRange(base...runBranch)` shows only the run's change). For the
// conflict scenario, `conflictOnRelease` advances `release` on the SAME line
// AFTER the run branched — so the two diverge from their common ancestor and a
// later `git merge --no-ff release ← runBranch` aborts on a textual conflict.
async function provisionM18RunBranch(
  repoPath: string,
  branch: string,
  worktreePath: string,
  opts: { fileName: string; runLine: string; conflictOnRelease?: string },
): Promise<{ baseCommit: string }> {
  // Base = the current `release` HEAD (the common ancestor the run forks from).
  const { stdout: baseSha } = await execFileAsync("git", [
    "-C",
    repoPath,
    "rev-parse",
    M18_TARGET_BRANCH,
  ]);
  const baseCommit = baseSha.trim();

  // The run branch + worktree, off `release`, with a committed change.
  await execFileAsync("git", [
    "-C",
    repoPath,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    M18_TARGET_BRANCH,
  ]);
  writeFileSync(path.join(worktreePath, opts.fileName), opts.runLine);
  await execFileAsync("git", ["-C", worktreePath, "add", opts.fileName]);
  await execFileAsync("git", [
    "-C",
    worktreePath,
    "commit",
    "-m",
    `run change on ${branch}`,
  ]);

  // Conflict case: advance `release` on the SAME line AFTER the run branched, so
  // the `--no-ff` merge of the run branch into `release` aborts.
  if (opts.conflictOnRelease) {
    const relWt = `${repoPath}/.worktrees/_rel-${randomUUID().slice(0, 8)}`;

    await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "add",
      relWt,
      M18_TARGET_BRANCH,
    ]);
    writeFileSync(path.join(relWt, opts.fileName), opts.conflictOnRelease);
    await execFileAsync("git", ["-C", relWt, "add", opts.fileName]);
    await execFileAsync("git", [
      "-C",
      relWt,
      "commit",
      "-m",
      "release diverges on the shared line",
    ]);
    await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "remove",
      "--force",
      relWt,
    ]);
  }

  return { baseCommit };
}

async function provisionM27Repo(args: {
  repoPath: string;
  remotePath: string;
  worktreeRoot: string;
  flowWorktreePath: string;
  scratchWorktreePath: string;
}): Promise<{ baseCommit: string }> {
  mkdirSync(path.dirname(args.repoPath), { recursive: true });
  await createGitRepo(args.repoPath);
  resetDir(args.remotePath);
  resetDir(args.worktreeRoot);
  await execFileAsync("git", [
    "-C",
    args.remotePath,
    "init",
    "--bare",
    "-b",
    "main",
  ]);
  await execFileAsync("git", [
    "-C",
    args.repoPath,
    "remote",
    "add",
    "origin",
    args.remotePath,
  ]);

  const { stdout: baseSha } = await execFileAsync("git", [
    "-C",
    args.repoPath,
    "rev-parse",
    "HEAD",
  ]);
  const baseCommit = baseSha.trim();

  await execFileAsync("git", [
    "-C",
    args.repoPath,
    "worktree",
    "add",
    "-b",
    M27_FLOW_BRANCH,
    args.flowWorktreePath,
    "main",
  ]);
  writeFileSync(
    path.join(args.flowWorktreePath, "dirty-lifecycle.txt"),
    "snapshot me before handoff\n",
    "utf8",
  );

  await execFileAsync("git", [
    "-C",
    args.repoPath,
    "worktree",
    "add",
    "-b",
    M27_SCRATCH_BRANCH,
    args.scratchWorktreePath,
    "main",
  ]);
  writeFileSync(
    path.join(args.scratchWorktreePath, "scratch-lifecycle.txt"),
    "scratch workbench lifecycle\n",
    "utf8",
  );

  return { baseCommit };
}

async function seedM18Fixture(
  pool: Pool,
  userId: string,
): Promise<M18FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    member: randomUUID(),
    // per-scenario task/run/workspace/hitl/attempt ids
    mergeTask: randomUUID(),
    mergeRun: randomUUID(),
    mergeWorkspace: randomUUID(),
    mergeHitl: randomUUID(),
    mergeImpl: randomUUID(),
    mergeReview: randomUUID(),
    conflictTask: randomUUID(),
    conflictRun: randomUUID(),
    conflictWorkspace: randomUUID(),
    conflictHitl: randomUUID(),
    conflictImpl: randomUUID(),
    conflictReview: randomUUID(),
    prTask: randomUUID(),
    prRun: randomUUID(),
    prWorkspace: randomUUID(),
    prHitl: randomUUID(),
    prImpl: randomUUID(),
    prReview: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M18_SLUG]);

  // Real parent repo + `release` target branch (points at base initially).
  mkdirSync(path.dirname(repoPath), { recursive: true });
  await createGitRepo(repoPath);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "branch",
    M18_TARGET_BRANCH,
    "main",
  ]);

  // Scenario worktrees + run-branch commits.
  const mergeWt = `${repoPath}/.worktrees/e2e-m18-merge`;
  const conflictWt = `${repoPath}/.worktrees/e2e-m18-conflict`;
  const prWt = `${repoPath}/.worktrees/e2e-m18-pr`;

  const merge = await provisionM18RunBranch(
    repoPath,
    M18_MERGE_BRANCH,
    mergeWt,
    {
      fileName: "feature-merge.txt",
      runLine: "clean merge change\n",
    },
  );
  const conflict = await provisionM18RunBranch(
    repoPath,
    M18_CONFLICT_BRANCH,
    conflictWt,
    {
      fileName: "shared.txt",
      runLine: "run side of the conflict\n",
      conflictOnRelease: "release side of the conflict\n",
    },
  );
  const pr = await provisionM18RunBranch(repoPath, M18_PR_BRANCH, prWt, {
    fileName: "feature-pr.txt",
    runLine: "pr-mode change\n",
  });

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, provider, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', 'github', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M18_SLUG,
      "MAIster E2E M18 Promotion",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-m18@v0.0.1`,
      JSON.stringify(M18_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  // Plant one flow Review run per scenario. Each: task InFlight → run Review →
  // workspace with base/target/promotion_mode → implement Succeeded + review
  // NeedsInput→Review ledger → review HITL. No blocking gates → readiness ready.
  type Scenario = {
    taskTitle: string;
    taskId: string;
    runId: string;
    workspaceId: string;
    hitlId: string;
    implId: string;
    reviewId: string;
    branch: string;
    worktreePath: string;
    baseCommit: string;
    promotionMode: "local_merge" | "pull_request";
    prUrl: string | null;
    prNumber: number | null;
  };

  const scenarios: Scenario[] = [
    {
      taskTitle: "E2E M18 clean merge",
      taskId: ids.mergeTask,
      runId: ids.mergeRun,
      workspaceId: ids.mergeWorkspace,
      hitlId: ids.mergeHitl,
      implId: ids.mergeImpl,
      reviewId: ids.mergeReview,
      branch: M18_MERGE_BRANCH,
      worktreePath: mergeWt,
      baseCommit: merge.baseCommit,
      promotionMode: "local_merge",
      prUrl: null,
      prNumber: null,
    },
    {
      taskTitle: "E2E M18 merge conflict",
      taskId: ids.conflictTask,
      runId: ids.conflictRun,
      workspaceId: ids.conflictWorkspace,
      hitlId: ids.conflictHitl,
      implId: ids.conflictImpl,
      reviewId: ids.conflictReview,
      branch: M18_CONFLICT_BRANCH,
      worktreePath: conflictWt,
      baseCommit: conflict.baseCommit,
      promotionMode: "local_merge",
      prUrl: null,
      prNumber: null,
    },
    {
      taskTitle: "E2E M18 PR display",
      taskId: ids.prTask,
      runId: ids.prRun,
      workspaceId: ids.prWorkspace,
      hitlId: ids.prHitl,
      implId: ids.prImpl,
      reviewId: ids.prReview,
      branch: M18_PR_BRANCH,
      worktreePath: prWt,
      baseCommit: pr.baseCommit,
      promotionMode: "pull_request",
      prUrl: M18_PR_URL,
      prNumber: M18_PR_NUMBER,
    },
  ];

  for (const s of scenarios) {
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
      [s.taskId, ids.project, s.taskTitle, "do the thing", ids.flow],
    );
    await pool.query(
      `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
       VALUES ($1, $2, $3, $4, 'Review', $5, 'v0.0.1', now())`,
      [s.runId, s.taskId, ids.project, ids.flow, M18_REVIEW_NODE],
    );
    await seedDefaultRunSession(pool, {
      capabilityAgent: "claude",
      runId: s.runId,
      runnerId: ids.runner,
      runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
    });
    await pool.query(
      `INSERT INTO workspaces
         (id, run_id, project_id, branch, worktree_path, parent_repo_path,
          base_branch, base_commit, target_branch, promotion_mode,
          pr_url, pr_number, promotion_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'none')`,
      [
        s.workspaceId,
        s.runId,
        ids.project,
        s.branch,
        s.worktreePath,
        repoPath,
        M18_TARGET_BRANCH,
        s.baseCommit,
        M18_TARGET_BRANCH,
        s.promotionMode,
        s.prUrl,
        s.prNumber,
      ],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
       VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
      [s.implId, s.runId],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
       VALUES ($1, $2, $3, 'human', 1, 'NeedsInput', now())`,
      [s.reviewId, s.runId, M18_REVIEW_NODE],
    );
    await pool.query(
      `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
       VALUES ($1, $2, $3, 'human', $4, $5)`,
      [
        s.hitlId,
        s.runId,
        M18_REVIEW_NODE,
        JSON.stringify(M18_REVIEW_SCHEMA),
        "Review the implementation, then promote to the target branch.",
      ],
    );
  }

  return {
    projectSlug: M18_SLUG,
    repoPath,
    targetBranch: M18_TARGET_BRANCH,
    mergeRunId: ids.mergeRun,
    mergeBranch: M18_MERGE_BRANCH,
    conflictRunId: ids.conflictRun,
    conflictBranch: M18_CONFLICT_BRANCH,
    prRunId: ids.prRun,
    prBranch: M18_PR_BRANCH,
    prUrl: M18_PR_URL,
    prNumber: M18_PR_NUMBER,
  };
}

async function seedM27Fixture(
  pool: Pool,
  userId: string,
): Promise<M27FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    member: randomUUID(),
    flowTask: randomUUID(),
    flowRun: randomUUID(),
    flowWorkspace: randomUUID(),
    flowImplement: randomUUID(),
    flowReview: randomUUID(),
    flowHitl: randomUUID(),
    scratchRun: randomUUID(),
    scratchWorkspace: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const remotePath = `/tmp/maister-e2e/${ids.project}.origin.git`;
  const worktreeRoot = path.resolve("e2e/.runtime/worktrees", ids.project);
  const flowWorktreePath = path.join(worktreeRoot, "flow");
  const scratchWorktreePath = path.join(worktreeRoot, "scratch");

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M27_SLUG]);

  const { baseCommit } = await provisionM27Repo({
    repoPath,
    remotePath,
    worktreeRoot,
    flowWorktreePath,
    scratchWorktreePath,
  });

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M27_SLUG,
      "MAIster E2E M27 Lifecycle",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-m27@v0.0.1`,
      JSON.stringify(M27_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), 'E2E M27 lifecycle', 'exercise lifecycle controls', $3, 'InFlight', 'Backlog')`,
    [ids.flowTask, ids.project, ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, created_by_user_id, started_at)
     VALUES ($1, $2, $3, $4, 'Review', 'review', 'v0.0.1', $5, now())`,
    [ids.flowRun, ids.flowTask, ids.project, ids.flow, userId],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.flowRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, 'main')`,
    [
      ids.flowWorkspace,
      ids.flowRun,
      ids.project,
      M27_FLOW_BRANCH,
      flowWorktreePath,
      repoPath,
      baseCommit,
    ],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, ended_at)
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Succeeded', now())`,
    [ids.flowImplement, ids.flowRun],
  );
  await pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
     VALUES ($1, $2, 'review', 'human', 1, 'NeedsInput', now())`,
    [ids.flowReview, ids.flowRun],
  );
  await pool.query(
    `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
     VALUES ($1, $2, 'review', 'human', $3, 'Review the lifecycle fixture.')`,
    [
      ids.flowHitl,
      ids.flowRun,
      JSON.stringify({
        review: true,
        allowedDecisions: ["approve", "rework"],
        transitions: { approve: "done", rework: "implement" },
      }),
    ],
  );
  await pool.query(
    `INSERT INTO runs (id, run_kind, project_id, flow_id, status, flow_version, created_by_user_id, started_at)
     VALUES ($1, 'scratch', $2, $3, 'Review', 'scratch', $4, now())`,
    [ids.scratchRun, ids.project, ids.flow, userId],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.scratchRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, 'main')`,
    [
      ids.scratchWorkspace,
      ids.scratchRun,
      ids.project,
      M27_SCRATCH_BRANCH,
      scratchWorktreePath,
      repoPath,
      baseCommit,
    ],
  );
  await pool.query(
    `INSERT INTO scratch_runs
       (run_id, project_id, name, initial_prompt, work_mode, reasoning_effort,
        plan_mode, base_branch, base_commit, target_branch, dialog_status,
        created_by_user_id)
     VALUES ($1, $2, 'M27 scratch lifecycle', 'Exercise scratch lifecycle controls.',
        'auto', 'high', 'off', 'main', $3, 'main', 'Review', $4)`,
    [ids.scratchRun, ids.project, baseCommit, userId],
  );

  return {
    projectSlug: M27_SLUG,
    repoPath,
    flowRunId: ids.flowRun,
    scratchRunId: ids.scratchRun,
    flowBranch: M27_FLOW_BRANCH,
    scratchBranch: M27_SCRATCH_BRANCH,
  };
}

// The M22 fixture carries the run id (workbench owner), the project slug (repo
// tab), the current node id (current-node emphasis), a Succeeded node id (node
// color), the run branch, and the seeded VIEWER credentials (member-gate proof).
type M22FixtureRecord = {
  projectSlug: string;
  repoPath: string;
  runId: string;
  branch: string;
  currentNode: string;
  succeededNode: string;
  oversizedFile: string;
  viewerEmail: string;
  viewerPassword: string;
};

// Build the M22 parent repo: base commit carrying README.md, src/app.ts, and an
// oversized tracked blob; then a run branch off base with a committed change so
// `diffRange(base...runBranch)` renders changed-files. Returns the base SHA.
async function provisionM22Repo(
  repoPath: string,
  worktreePath: string,
  branch: string,
  oversizedFile: string,
): Promise<{ baseCommit: string }> {
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

  writeFileSync(
    path.join(repoPath, "README.md"),
    "# M22 workbench fixture\n",
    "utf8",
  );
  mkdirSync(path.join(repoPath, "src"), { recursive: true });
  writeFileSync(
    path.join(repoPath, "src", "app.ts"),
    "export const answer = 42;\n",
    "utf8",
  );
  writeFileSync(
    path.join(repoPath, oversizedFile),
    "x".repeat(M22_OVERSIZED_BYTES),
    "utf8",
  );
  await execFileAsync("git", ["-C", repoPath, "add", "."]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "base"]);

  const { stdout: baseSha } = await execFileAsync("git", [
    "-C",
    repoPath,
    "rev-parse",
    "HEAD",
  ]);
  const baseCommit = baseSha.trim();

  // Run branch + worktree off base, with a committed change so the Diff tab
  // shows a changed file (README.md modified) on the run branch vs base.
  await execFileAsync("git", [
    "-C",
    repoPath,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);
  writeFileSync(
    path.join(worktreePath, "README.md"),
    "# M22 workbench fixture\n\nworkbench diff change\n\n```mermaid\ngraph TD; A-->B;\n```\n",
    "utf8",
  );
  await execFileAsync("git", ["-C", worktreePath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    worktreePath,
    "commit",
    "-m",
    "run change on m22 branch",
  ]);

  return { baseCommit };
}

async function seedM22Fixture(
  pool: Pool,
  userId: string,
  viewer: UserFixture,
): Promise<M22FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    task: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    member: randomUUID(),
    viewerMember: randomUUID(),
    planAttempt: randomUUID(),
    implAttempt: randomUUID(),
    checksAttempt: randomUUID(),
    reviewAttempt: randomUUID(),
    gate: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-m22-workbench`;
  const oversizedFile = "big.txt";

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M22_SLUG]);

  mkdirSync(path.dirname(repoPath), { recursive: true });
  const { baseCommit } = await provisionM22Repo(
    repoPath,
    worktreePath,
    M22_BRANCH,
    oversizedFile,
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M22_SLUG,
      "MAIster E2E M22 Workbench",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-m22@v0.0.1`,
      JSON.stringify(M22_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), $3, $4, $5, 'InFlight', 'Backlog')`,
    [ids.task, ids.project, "E2E workbench", "do the thing", ids.flow],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
     VALUES ($1, $2, $3, $4, 'Running', $5, 'v0.0.1', now())`,
    [ids.run, ids.task, ids.project, ids.flow, M22_CURRENT_NODE],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, 'main')`,
    [
      ids.workspace,
      ids.run,
      ids.project,
      M22_BRANCH,
      worktreePath,
      repoPath,
      baseCommit,
    ],
  );

  // Ledger: plan Succeeded → implement Running (the current node) → review
  // Pending. The `checks` Succeeded attempt carries a PASSED blocking gate so a
  // gate rollup is present on the graph.
  const attempts: Array<[string, string, string, string]> = [
    [ids.planAttempt, "plan", "ai_coding", "Succeeded"],
    [ids.implAttempt, M22_CURRENT_NODE, "ai_coding", "Running"],
    [ids.checksAttempt, "checks", "check", "Succeeded"],
    [ids.reviewAttempt, "review", "human", "Pending"],
  ];

  for (const [id, nodeId, nodeType, status] of attempts) {
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
       VALUES ($1, $2, $3, $4, 1, $5, now())`,
      [id, ids.run, nodeId, nodeType, status],
    );
  }
  await pool.query(
    `INSERT INTO gate_results (id, run_id, node_attempt_id, gate_id, kind, mode, status, ended_at)
     VALUES ($1, $2, $3, 'lint', 'command_check', 'blocking', 'passed', now())`,
    [ids.gate, ids.run, ids.checksAttempt],
  );

  // The admin owner (workbench owner / member-gate pass) + a VIEWER member
  // (below readRepoFiles' `member` floor → 403 on the file routes).
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'viewer')`,
    [ids.viewerMember, ids.project, viewer.id],
  );

  return {
    projectSlug: M22_SLUG,
    repoPath,
    runId: ids.run,
    branch: M22_BRANCH,
    currentNode: M22_CURRENT_NODE,
    succeededNode: "plan",
    oversizedFile,
    viewerEmail: viewer.email,
    viewerPassword: viewer.password,
  };
}

// --- Scratch detail fixture (M35 T3.5) -------------------------------------
// A scratch run on the shared run shell: WaitingForUser (composer enabled), a
// committed branch diff (change size + Diff tab), tracked files (Files tab),
// and a short transcript (conversation center). Reuses provisionM22Repo for the
// real parent repo (README.md + src/app.ts + a committed run-branch change).
const SCRATCH_DETAIL_SLUG = "e2e-scratch-detail";
const SCRATCH_DETAIL_BRANCH = "maister/e2e-scratch-detail";

type ScratchDetailFixtureRecord = {
  projectSlug: string;
  repoPath: string;
  scratchRunId: string;
  branch: string;
};

async function seedScratchDetailFixture(
  pool: Pool,
  userId: string,
): Promise<ScratchDetailFixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    run: randomUUID(),
    workspace: randomUUID(),
    member: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const worktreePath = `${repoPath}/.worktrees/e2e-scratch-detail`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [
    SCRATCH_DETAIL_SLUG,
  ]);

  mkdirSync(path.dirname(repoPath), { recursive: true });
  const { baseCommit } = await provisionM22Repo(
    repoPath,
    worktreePath,
    SCRATCH_DETAIL_BRANCH,
    "big.txt",
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      SCRATCH_DETAIL_SLUG,
      "MAIster E2E Scratch Detail",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  await pool.query(
    `INSERT INTO capability_records
       (id, project_id, capability_ref_id, kind, label, source, agents, material)
     VALUES ($1, $2, 'aif-plan', 'skill', 'AIF Plan', 'flow-package',
       '["claude","codex"]'::jsonb,
       '{"description":"Plan a feature","argHint":"<feature>"}'::jsonb)`,
    [randomUUID(), ids.project],
  );
  // run.status mirrors runStatusForDialogStatus("WaitingForUser") = "Running".
  // Pure scratch runs carry no task or flow (flow_id null).
  await pool.query(
    `INSERT INTO runs (id, run_kind, project_id, status, flow_version, created_by_user_id, started_at)
     VALUES ($1, 'scratch', $2, 'Running', 'scratch', $3, now())`,
    [ids.run, ids.project, userId],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.run,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
     VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, 'main')`,
    [
      ids.workspace,
      ids.run,
      ids.project,
      SCRATCH_DETAIL_BRANCH,
      worktreePath,
      repoPath,
      baseCommit,
    ],
  );
  await pool.query(
    `INSERT INTO scratch_runs
       (run_id, project_id, name, initial_prompt, work_mode, reasoning_effort,
        plan_mode, base_branch, base_commit, target_branch, dialog_status,
        created_by_user_id)
     VALUES ($1, $2, 'Scratch detail fixture', 'Edit the README.', 'auto', 'high',
        'off', 'main', $3, 'main', 'WaitingForUser', $4)`,
    [ids.run, ids.project, baseCommit, userId],
  );
  const messages: Array<[number, "user" | "assistant", string]> = [
    [1, "user", "Please tweak the README."],
    [2, "assistant", "Done — updated README.md. Anything else?"],
  ];

  for (const [sequence, role, content] of messages) {
    await pool.query(
      `INSERT INTO run_messages (id, run_id, sequence, role, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), ids.run, sequence, role, content],
    );
  }

  return {
    projectSlug: SCRATCH_DETAIL_SLUG,
    repoPath,
    scratchRunId: ids.run,
    branch: SCRATCH_DETAIL_BRANCH,
  };
}

type M23FixtureRecord = {
  projectId: string;
  projectSlug: string;
  flowId: string;
  nodeId: string;
};

// --- M23 fixture: read-only Observatory metrics ----------------------------
// ONE project with two flow runs carrying repeated check retries, failed
// blocking gates, rework HITL rows, and log artifacts. No supervisor or
// worktree is needed: Observatory reads only existing DB evidence.

const M23_SLUG = "e2e-m23";
const M23_NODE_ID = "checks";
const M23_GATE_ID = "unit";

// M29 harness layer: `lint` never fails (10 passed executions >= the default
// MAISTER_HARNESS_NEVER_FIRED_MIN) -> never-fired badge; `implement` declares
// a skill guide with zero gates -> guides-without-sensors coverage flag.
const M23_SILENT_GATE_ID = "lint";

const M23_MANIFEST = {
  schemaVersion: 1,
  name: "AIF Observatory (e2e)",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "implement {{ task.prompt }}" },
      settings: { skills: ["aif-implement"] },
      transitions: { success: M23_NODE_ID },
    },
    {
      id: M23_NODE_ID,
      type: "check",
      action: { command: "pnpm test" },
      pre_finish: {
        gates: [
          { id: M23_GATE_ID, kind: "command_check", mode: "blocking" },
          { id: M23_SILENT_GATE_ID, kind: "command_check", mode: "blocking" },
        ],
      },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      transitions: { approve: "done", rework: "implement" },
    },
  ],
};

async function seedM23Fixture(
  pool: Pool,
  userId: string,
): Promise<M23FixtureRecord> {
  const ids = {
    project: randomUUID(),
    runner: randomUUID(),
    flow: randomUUID(),
    revision: randomUUID(),
    firstTask: randomUUID(),
    secondTask: randomUUID(),
    firstRun: randomUUID(),
    secondRun: randomUUID(),
    member: randomUUID(),
    firstCheck1: randomUUID(),
    firstCheck2: randomUUID(),
    firstReview: randomUUID(),
    secondCheck1: randomUUID(),
    secondCheck2: randomUUID(),
    secondReview: randomUUID(),
    firstGate: randomUUID(),
    secondGate: randomUUID(),
    firstGatePassed: randomUUID(),
    secondGatePassed: randomUUID(),
    firstHitl: randomUUID(),
    secondHitl: randomUUID(),
    firstArtifact: randomUUID(),
    secondArtifact: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M23_SLUG]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M23_SLUG,
      "MAIster E2E M23 Observatory",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
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
      `/tmp/maister-e2e/flows/aif-observatory@v0.0.1`,
      JSON.stringify(M23_MANIFEST),
    ],
  );
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision,
        manifest_digest, manifest, schema_version, installed_path)
     VALUES ($1, 'aif', $2, 'v0.0.1', $3, $4, $5, 1, $6)`,
    [
      ids.revision,
      "github.com/maister/maister-flow-aif",
      `rev-${ids.revision}`,
      `digest-${ids.revision}`,
      JSON.stringify(M23_MANIFEST),
      `/tmp/maister-e2e/flows/aif-observatory@v0.0.1`,
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES
       ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2), 'E2E observatory first', 'observe first', $3, 'InFlight', 'InFlight'),
       ($4, $2, (SELECT COALESCE(MAX(number), 0) + 2 FROM tasks WHERE project_id = $2), 'E2E observatory second', 'observe second', $3, 'InFlight', 'InFlight')`,
    [ids.firstTask, ids.project, ids.flow, ids.secondTask],
  );
  await pool.query(
    `INSERT INTO runs
       (id, task_id, project_id, flow_id, flow_revision_id,
        status, current_step_id, flow_version, started_at, ended_at)
     VALUES
       ($1, $2, $3, $4, $8, 'Review', 'review', 'v0.0.1',
        now() - interval '3 hours', now() - interval '2 hours'),
       ($5, $6, $3, $4, $8, 'Running', $7, 'v0.0.1',
        now() - interval '90 minutes', null)`,
    [
      ids.firstRun,
      ids.firstTask,
      ids.project,
      ids.flow,
      ids.secondRun,
      ids.secondTask,
      M23_NODE_ID,
      ids.revision,
    ],
  );
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.firstRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await seedDefaultRunSession(pool, {
    capabilityAgent: "claude",
    runId: ids.secondRun,
    runnerId: ids.runner,
    runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
  });
  await pool.query(
    `INSERT INTO node_attempts
       (id, run_id, node_id, node_type, attempt, status, error_code, exit_code, started_at, ended_at)
     VALUES
       ($1, $2, $3, 'check', 1, 'Failed', 'TEST_FAIL', 1, now() - interval '170 minutes', now() - interval '168 minutes'),
       ($4, $2, $3, 'check', 2, 'Succeeded', 'TEST_FAIL', null, now() - interval '166 minutes', now() - interval '164 minutes'),
       ($5, $2, 'review', 'human', 1, 'Reworked', null, null, now() - interval '150 minutes', now() - interval '145 minutes'),
       ($6, $7, $3, 'check', 1, 'Failed', 'TEST_FAIL', 1, now() - interval '80 minutes', now() - interval '78 minutes'),
       ($8, $7, $3, 'check', 2, 'Succeeded', 'TEST_FAIL', null, now() - interval '76 minutes', null),
       ($9, $7, 'review', 'human', 1, 'Reworked', null, null, now() - interval '70 minutes', now() - interval '68 minutes')`,
    [
      ids.firstCheck1,
      ids.firstRun,
      M23_NODE_ID,
      ids.firstCheck2,
      ids.firstReview,
      ids.secondCheck1,
      ids.secondRun,
      ids.secondCheck2,
      ids.secondReview,
    ],
  );
  await pool.query(
    `INSERT INTO gate_results
       (id, run_id, node_attempt_id, gate_id, kind, mode, status, verdict)
     VALUES
       ($1, $2, $3, $4, 'command_check', 'blocking', 'failed', $5::jsonb),
       ($6, $7, $8, $4, 'command_check', 'blocking', 'failed', $9::jsonb),
       ($10, $2, $11, $4, 'command_check', 'blocking', 'passed', null),
       ($12, $7, $13, $4, 'command_check', 'blocking', 'passed', null)`,
    [
      ids.firstGate,
      ids.firstRun,
      ids.firstCheck1,
      M23_GATE_ID,
      JSON.stringify({ verdict: "fail", reasons: ["ACCESS_TOKEN=abc failed"] }),
      ids.secondGate,
      ids.secondRun,
      ids.secondCheck1,
      JSON.stringify({ verdict: "fail", recommendedAction: "rerun tests" }),
      ids.firstGatePassed,
      ids.firstCheck2,
      ids.secondGatePassed,
      ids.secondCheck2,
    ],
  );
  // 10 passing executions of the declared-silent gate -> never-fired flag at
  // the default MAISTER_HARNESS_NEVER_FIRED_MIN=10 threshold.
  for (let index = 0; index < 10; index += 1) {
    await pool.query(
      `INSERT INTO gate_results
         (id, run_id, node_attempt_id, gate_id, kind, mode, status, verdict)
       VALUES ($1, $2, $3, $4, 'command_check', 'blocking', 'passed', null)`,
      [
        randomUUID(),
        index % 2 === 0 ? ids.firstRun : ids.secondRun,
        index % 2 === 0 ? ids.firstCheck2 : ids.secondCheck2,
        M23_SILENT_GATE_ID,
      ],
    );
  }
  await pool.query(
    `INSERT INTO hitl_requests
       (id, run_id, step_id, kind, prompt, decision, rework_target,
        workspace_policy, created_at, responded_at)
     VALUES
       ($1, $2, 'review', 'human', 'Review', 'rework', 'implement', 'keep',
        now() - interval '150 minutes', now() - interval '145 minutes'),
       ($3, $4, 'review', 'human', 'Review', 'rework', 'implement', 'keep',
        now() - interval '70 minutes', now() - interval '68 minutes')`,
    [ids.firstHitl, ids.firstRun, ids.secondHitl, ids.secondRun],
  );
  await pool.query(
    `INSERT INTO artifact_instances
       (id, run_id, node_attempt_id, node_id, attempt, artifact_def_id, kind,
        producer, locator, validity)
     VALUES
       ($1, $2, $3, $4, 2, null, 'log', 'runner', $5::jsonb, 'current'),
       ($6, $7, $8, $4, 2, null, 'log', 'runner', $9::jsonb, 'current')`,
    [
      ids.firstArtifact,
      ids.firstRun,
      ids.firstCheck2,
      M23_NODE_ID,
      JSON.stringify({ kind: "inline", text: "checks recovered" }),
      ids.secondArtifact,
      ids.secondRun,
      ids.secondCheck2,
      JSON.stringify({ kind: "inline", text: "checks recovered again" }),
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );

  return {
    projectId: ids.project,
    projectSlug: M23_SLUG,
    flowId: ids.flow,
    nodeId: M23_NODE_ID,
  };
}

// --- M27 fixture: authored flow capability for the flow-graph editor ---------
// ONE project with a DRAFT authored `flow` capability whose manifest compiles
// (plan ai_coding -> review human), so the editor page renders the canvas +
// diff tabs. The e2e adds a node via the toolbar, saves through the existing
// updateAuthoredFlowAction form, and asserts persistence + the invalid-edit
// hard-gate refusal.
const M27_EDITOR_SLUG = "e2e-m27-editor";

const M27_EDITOR_MANIFEST = {
  schemaVersion: 1,
  name: "M27 Editor Flow",
  compat: { engine_min: "1.3.0" },
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "Plan the work" },
      transitions: { done: "review" },
    },
    { id: "review", type: "human", transitions: { approve: "done" } },
  ],
};

const M27_FLOW_YAML = `schemaVersion: 1
name: M27 Editor Flow
compat:
  engine_min: "1.3.0"
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: Plan the work
    transitions:
      done: review
  - id: review
    type: human
    transitions:
      approve: done
`;

async function seedM27FlowEditorFixture(
  pool: Pool,
  adminId: string,
): Promise<{ projectId: string; projectSlug: string; capId: string }> {
  const ids = {
    project: randomUUID(),
    member: randomUUID(),
    cap: randomUUID(),
    revision: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M27_EDITOR_SLUG]);
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      M27_EDITOR_SLUG,
      "M27 Flow Editor (e2e)",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, adminId],
  );

  const body = {
    flowYaml: M27_FLOW_YAML,
    manifest: M27_EDITOR_MANIFEST,
    packageMetadata: { slug: M27_EDITOR_SLUG, name: "M27 Editor Flow" },
    files: [],
    validation: {
      status: "valid",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };

  await pool.query(
    `INSERT INTO authored_capabilities
       (id, project_id, kind, slug, title, lifecycle, draft_version,
        current_draft_revision_id)
     VALUES ($1, $2, 'flow', $3, $4, 'DRAFT', 1, $5)`,
    [ids.cap, ids.project, M27_EDITOR_SLUG, "M27 Editor Flow", ids.revision],
  );
  await pool.query(
    `INSERT INTO authored_capability_revisions
       (id, capability_id, project_id, kind, revision_number, lifecycle,
        draft_version, title, body, manifest, schema_version, content_hash)
     VALUES ($1, $2, $3, 'flow', 1, 'DRAFT', 1, $4, $5::jsonb, $6::jsonb, 1, $7)`,
    [
      ids.revision,
      ids.cap,
      ids.project,
      "M27 Editor Flow",
      JSON.stringify(body),
      JSON.stringify(M27_EDITOR_MANIFEST),
      "m27-e2e-seed",
    ],
  );

  return {
    projectId: ids.project,
    projectSlug: M27_EDITOR_SLUG,
    capId: ids.cap,
  };
}

// --- flows-authoring fixture: a DRAFT authored Flow capability to open in the
// CodeMirror editor (ADR-066 Phase 3). No real repo/worktree — the editor reads
// `body.flowYaml` straight from the revision row. The page resolves `capId`
// against `authored_capabilities.id`, scoped to the project.

const FLOWS_AUTHORING_SLUG = "e2e-flows-authoring";
const FLOWS_AUTHORING_CAP_SLUG = "e2e-authoring-flow";

const FLOWS_AUTHORING_FLOW_YAML = `schemaVersion: 1
name: E2E Authoring Flow
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "/aif-plan {{ task.prompt }}"
`;

type FlowsAuthoringFixtureRecord = {
  projectSlug: string;
  capId: string;
  capSlug: string;
};

async function seedFlowsAuthoringFixture(
  pool: Pool,
  userId: string,
): Promise<FlowsAuthoringFixtureRecord> {
  const ids = {
    project: randomUUID(),
    member: randomUUID(),
    cap: randomUUID(),
    revision: randomUUID(),
  };
  const repoPath = `/tmp/maister-e2e/${ids.project}`;
  const body = {
    flowYaml: FLOWS_AUTHORING_FLOW_YAML,
    manifest: null,
    packageMetadata: {
      slug: FLOWS_AUTHORING_CAP_SLUG,
      name: "E2E Authoring Flow",
      versionLabel: "none",
    },
    files: [],
    validation: {
      status: "valid",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [
    FLOWS_AUTHORING_SLUG,
  ]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      ids.project,
      FLOWS_AUTHORING_SLUG,
      "MAIster E2E Flows Authoring",
      repoPath,
      `${repoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  await pool.query(
    `INSERT INTO authored_capabilities
       (id, project_id, kind, slug, title, lifecycle, draft_version,
        current_draft_revision_id)
     VALUES ($1, $2, 'flow', $3, $4, 'DRAFT', 1, $5)`,
    [
      ids.cap,
      ids.project,
      FLOWS_AUTHORING_CAP_SLUG,
      "E2E Authoring Flow",
      ids.revision,
    ],
  );
  await pool.query(
    `INSERT INTO authored_capability_revisions
       (id, capability_id, project_id, kind, revision_number, lifecycle,
        draft_version, title, body, manifest, schema_version, content_hash)
     VALUES ($1, $2, $3, 'flow', 1, 'DRAFT', 1, $4, $5::jsonb, NULL, 1, $6)`,
    [
      ids.revision,
      ids.cap,
      ids.project,
      "E2E Authoring Flow",
      JSON.stringify(body),
      "e2e0000000000000000000000000000000000000000000000000000000000000",
    ],
  );

  return {
    projectSlug: FLOWS_AUTHORING_SLUG,
    capId: ids.cap,
    capSlug: FLOWS_AUTHORING_CAP_SLUG,
  };
}

// --- Flow Studio Phase 2 (T5.1): artifact-editing DRAFT fixture --------------
// A DEDICATED authored `flow` DRAFT the artifact-editing spec opens DIRECTLY
// (page.goto /flows/<slug>/<capId>, like flows-authoring) — NOT a fork of the
// shared installed package. Decoupling kills the slug-probe race that flaked
// when flow-studio-artifacts and flow-package-viewer both forked aif-flow-viewer
// under fullyParallel (both probed the same free `aif-flow-viewer-fork` slug →
// one lost the (project_id,kind,slug) unique → CONFLICT 409).
//
// The body MIRRORS what `readAuthoredFlowPackageDirectory` produces for the
// viewer bundle (same flow.yaml + same SKILL.md / review.json / rule / script /
// setup / readme files), so the editor surface is byte-identical to a fork:
// the SKILL.md frontmatter form (journey 1), the review.json form-schema builder
// (journey 2), and — because the revision `manifest` column carries the 2-node
// graph with `compat.engine_min` — the Graph tab (journeys 3 + 4).
const FLOW_STUDIO_ARTIFACTS_SLUG = "e2e-flow-studio-artifacts";
const FLOW_STUDIO_ARTIFACTS_CAP_SLUG = "flow-package-viewer-demo";

// The body files: the viewer bundle (minus flow.yaml), classified by path and
// sorted by path — exactly the shape readAuthoredFlowPackageDirectory emits.
const FLOW_STUDIO_ARTIFACTS_FILES = Object.entries(FLOW_VIEWER_BUNDLE_FILES)
  .map(([rel, content]) => ({
    kind: classifyBundlePath(rel),
    path: rel,
    content,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

type FlowStudioArtifactsFixtureRecord = {
  projectSlug: string;
  capId: string;
  implementNode: string;
  reviewNode: string;
};

async function seedFlowStudioArtifactsFixture(
  pool: Pool,
  userId: string,
): Promise<FlowStudioArtifactsFixtureRecord> {
  const ids = {
    project: randomUUID(),
    member: randomUUID(),
    cap: randomUUID(),
    revision: randomUUID(),
  };
  const repoPath = `${RUNTIME_ROOT}/${ids.project}`;
  const body = {
    flowYaml: FLOW_VIEWER_FLOW_YAML,
    manifest: FLOW_VIEWER_MANIFEST,
    packageMetadata: {
      slug: FLOW_STUDIO_ARTIFACTS_CAP_SLUG,
      name: "flow-package-viewer-demo",
      versionLabel: "none",
    },
    files: FLOW_STUDIO_ARTIFACTS_FILES,
    validation: {
      status: "valid",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [
    FLOW_STUDIO_ARTIFACTS_SLUG,
  ]);

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, $6)`,
    [
      ids.project,
      FLOW_STUDIO_ARTIFACTS_SLUG,
      "MAIster E2E Flow Studio Artifacts",
      repoPath,
      `${repoPath}/maister.yaml`,
      "E2EFSA",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  await pool.query(
    `INSERT INTO authored_capabilities
       (id, project_id, kind, slug, title, lifecycle, draft_version,
        current_draft_revision_id)
     VALUES ($1, $2, 'flow', $3, $4, 'DRAFT', 1, $5)`,
    [
      ids.cap,
      ids.project,
      FLOW_STUDIO_ARTIFACTS_CAP_SLUG,
      "flow-package-viewer-demo",
      ids.revision,
    ],
  );
  // The revision `manifest` column carries the 2-node graph (NOT null) so the
  // editor's buildAuthoredFlowGraph compiles → the Graph tab is available.
  await pool.query(
    `INSERT INTO authored_capability_revisions
       (id, capability_id, project_id, kind, revision_number, lifecycle,
        draft_version, title, body, manifest, schema_version, content_hash)
     VALUES ($1, $2, $3, 'flow', 1, 'DRAFT', 1, $4, $5::jsonb, $6::jsonb, 1, $7)`,
    [
      ids.revision,
      ids.cap,
      ids.project,
      "flow-package-viewer-demo",
      JSON.stringify(body),
      JSON.stringify(FLOW_VIEWER_MANIFEST),
      "e2e1111111111111111111111111111111111111111111111111111111111111",
    ],
  );

  return {
    projectSlug: FLOW_STUDIO_ARTIFACTS_SLUG,
    capId: ids.cap,
    implementNode: FLOW_VIEWER_IMPLEMENT_NODE,
    reviewNode: FLOW_VIEWER_REVIEW_NODE,
  };
}

// --- Flow Studio Phase 2 (T2.5): installed-package viewer + fork fixture -----
// Writes a REAL immutable bundle to disk, then plants the `flows` + enabled
// `flow_revisions` rows pointing at it. The bundle dir is rebuilt from scratch
// each run (rm + recreate) so re-seeds are clean. `flows.source` ==
// `flow_revisions.source` (the `getFlowPackageDetail` join keys on both), and
// `package_status='Installed'` keeps the revision out of the `Removed` filter.
async function seedInstalledPackageFixture(
  pool: Pool,
  userId: string,
): Promise<FlowViewerFixtureRecord> {
  const ids = {
    project: randomUUID(),
    member: randomUUID(),
    flow: randomUUID(),
    revision: randomUUID(),
  };
  const repoPath = `${RUNTIME_ROOT}/${ids.project}`;
  const source = "github.com/maister/maister-flow-aif-viewer";
  const installedPath = `${RUNTIME_ROOT}/flows/${FLOW_VIEWER_REF}@${FLOW_VIEWER_VERSION}`;

  // Rebuild the on-disk bundle from scratch (idempotent across re-runs).
  rmSync(installedPath, { recursive: true, force: true });
  mkdirSync(installedPath, { recursive: true });
  writeFileSync(
    path.join(installedPath, "flow.yaml"),
    FLOW_VIEWER_FLOW_YAML,
    "utf8",
  );
  for (const [rel, content] of Object.entries(FLOW_VIEWER_BUNDLE_FILES)) {
    const abs = path.join(installedPath, rel);

    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [FLOW_VIEWER_SLUG]);
  // Scope by source too — flow_ref_id is NOT globally unique across projects, so
  // an unscoped delete could wipe an unrelated flow's revisions (Reviewer pass).
  await pool.query(
    `DELETE FROM flow_revisions WHERE flow_ref_id = $1 AND source = $2`,
    [FLOW_VIEWER_REF, source],
  );

  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, 'main', $5, $6)`,
    [
      ids.project,
      FLOW_VIEWER_SLUG,
      "MAIster E2E Flow Viewer",
      repoPath,
      `${repoPath}/maister.yaml`,
      "E2EFVW",
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [ids.member, ids.project, userId],
  );
  // The enabled revision: Installed + supported schema + on-disk bundle. The
  // viewer compiles `manifest` for the static graph and reads `installed_path`
  // for the raw flow.yaml + file list. `exec_trust='untrusted'` drives the
  // script-editor trust banner (display-only).
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision, manifest_digest,
        manifest, schema_version, engine_min, installed_path, setup_status,
        package_status, exec_trust)
     VALUES ($1, $2, $3, $4, 'rev-flow-viewer',
        'f10wv1ewe40000000000000000000000000000000', $5, 1, '1.1.0', $6, 'done',
        'Installed', 'untrusted')`,
    [
      ids.revision,
      FLOW_VIEWER_REF,
      source,
      FLOW_VIEWER_VERSION,
      JSON.stringify(FLOW_VIEWER_MANIFEST),
      installedPath,
    ],
  );
  // The project flow row: Enabled + trusted, pointing at the revision. The
  // packages tab lists this (getFlowPackages) → the card links to the viewer.
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision, installed_path,
        manifest, schema_version, enabled_revision_id, enablement_state, trust_status)
     VALUES ($1, $2, $3, $4, $5, 'rev-flow-viewer', $6, $7, 1, $8, 'Enabled', 'trusted')`,
    [
      ids.flow,
      ids.project,
      FLOW_VIEWER_REF,
      source,
      FLOW_VIEWER_VERSION,
      installedPath,
      JSON.stringify(FLOW_VIEWER_MANIFEST),
      ids.revision,
    ],
  );

  return {
    projectSlug: FLOW_VIEWER_SLUG,
    flowRefId: FLOW_VIEWER_REF,
    revisionId: ids.revision,
    implementNode: FLOW_VIEWER_IMPLEMENT_NODE,
    reviewNode: FLOW_VIEWER_REVIEW_NODE,
    sampleFilePath: "skills/demo/SKILL.md",
  };
}

type PlatformAgentsFixture = ProjectFixture & {
  helperAgentId: string;
  auditorAgentId: string;
  manualTaskId: string;
  manualTaskNumber: number;
  boundTaskId: string;
  boundTaskNumber: number;
  agentBodyMarker: string;
  agentsRoot: string;
  // The repo_read quarantine scenario gets its OWN project: the spec dirties
  // this repo mid-run, which would flake the clean-parent-repo precondition
  // of the flow-binding launch if they shared one.
  quarantine: {
    projectId: string;
    projectSlug: string;
    repoPath: string;
    taskId: string;
    taskNumber: number;
  };
};

function writeAgentDefinition(args: {
  agentsRoot: string;
  id: string;
  workspace: "none" | "repo_read" | "worktree";
  triggers: string[];
  body: string;
}): string {
  // ADR-089 rework: ids are package-qualified `<pkg>:<stem>`; the definition
  // file is `agents/<stem>.md` (the seed mimics an installed package dir).
  const stem = args.id.split(":").pop() ?? args.id;
  const dir = path.join(args.agentsRoot, "agents");

  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stem}.md`);

  writeFileSync(
    file,
    `---
name: ${stem}
description: e2e fixture agent
workspace: ${args.workspace}
mode: session
triggers:
${args.triggers.map((t) => `  - ${t}`).join("\n")}
risk_tier: read_only
---
${args.body}
`,
    "utf8",
  );

  return file;
}

async function seedPlatformAgentsFixture(
  pool: Pool,
  adminId: string,
): Promise<PlatformAgentsFixture> {
  const base = await seedLaunchableProjectFixture(pool, {
    slug: AGENTS_SLUG,
    projectName: "E2E Agents",
    userId: adminId,
    repoPath: path.join(RUNTIME_ROOT, "repos", AGENTS_SLUG),
    task: {
      title: "Manual agent launch target",
      prompt: "Target task for the standalone agent runs.",
      status: "Backlog",
      stage: "Backlog",
    },
  });
  const manualTaskId = base.taskId!;
  const manualTaskNumber = Number(
    (await pool.query(`SELECT number FROM tasks WHERE id = $1`, [manualTaskId]))
      .rows[0].number,
  );

  // A package-shaped dir holding the fixture agents/<stem>.md definitions —
  // `agents.source_path` points straight at these files (ADR-089 rework).
  const agentsRoot = path.join(RUNTIME_ROOT, "agents");
  const helperPath = writeAgentDefinition({
    agentsRoot,
    id: E2E_HELPER_AGENT,
    workspace: "none",
    triggers: ["manual", "flow"],
    body: `${AGENT_BODY_MARKER}\nYou are the e2e helper agent. Reply tersely.`,
  });
  const auditorPath = writeAgentDefinition({
    agentsRoot,
    id: E2E_AUDITOR_AGENT,
    workspace: "repo_read",
    triggers: ["manual"],
    body: "You audit the repository without writing anything.",
  });

  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [
    [E2E_HELPER_AGENT, E2E_AUDITOR_AGENT],
  ]);
  await pool.query(
    `INSERT INTO agents
       (id, package_name, version_label, origin, name, description, workspace,
        mode, triggers, risk_tier, source_path)
     VALUES
       ($1, 'e2e-agents-pkg', 'v1.0.0', 'git', $1, 'e2e fixture agent', 'none',
        'session', '["manual","flow"]'::jsonb, 'read_only', $2),
       ($3, 'e2e-agents-pkg', 'v1.0.0', 'git', $3, 'e2e fixture agent',
        'repo_read', 'session', '["manual"]'::jsonb, 'read_only', $4)`,
    [E2E_HELPER_AGENT, helperPath, E2E_AUDITOR_AGENT, auditorPath],
  );
  // RD4: launches resolve the EFFECTIVE definition through the project's
  // pinned revision of the providing package — register the e2e-agents-pkg
  // revision (installedPath = the dir writeAgentDefinition fills) and pin it
  // Enabled+trusted in the consuming projects.
  const agentsPkgRevisionId = randomUUID();

  await pool.query(
    `DELETE FROM flow_revisions WHERE flow_ref_id = 'e2e-agents-pkg'`,
  );
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision,
        manifest_digest, manifest, schema_version, installed_path, package_status)
     VALUES ($1, 'e2e-agents-pkg', 'github.com/maister/e2e-agents-pkg', 'v1.0.0',
             'rev-e2e-agents', 'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [agentsPkgRevisionId, agentsRoot],
  );

  const pinAgentsPkg = async (projectId: string): Promise<void> => {
    await pool.query(
      `INSERT INTO flows
         (id, project_id, flow_ref_id, source, version, installed_path,
          manifest, schema_version, enabled_revision_id, enablement_state,
          trust_status, version_binding)
       VALUES ($1, $2, 'e2e-agents-pkg', 'github.com/maister/e2e-agents-pkg',
               'v1.0.0', $3, '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
      [randomUUID(), projectId, agentsRoot, agentsPkgRevisionId],
    );
  };

  await pinAgentsPkg(base.projectId);
  // The quarantine project — the auditor (repo_read) is linked HERE only.
  const quarantineBase = await seedLaunchableProjectFixture(pool, {
    slug: `${AGENTS_SLUG}-quarantine`,
    projectName: "E2E Agents Quarantine",
    userId: adminId,
    repoPath: path.join(RUNTIME_ROOT, "repos", `${AGENTS_SLUG}-quarantine`),
    task: {
      title: "Audit target",
      prompt: "Target task for the repo_read quarantine run.",
      status: "Backlog",
      stage: "Backlog",
    },
  });
  const quarantineTaskNumber = Number(
    (
      await pool.query(`SELECT number FROM tasks WHERE id = $1`, [
        quarantineBase.taskId!,
      ])
    ).rows[0].number,
  );

  await pinAgentsPkg(quarantineBase.projectId);

  await pool.query(
    `INSERT INTO agent_project_links (id, agent_id, project_id)
     VALUES ($1, $2, $3), ($4, $5, $6)`,
    [
      randomUUID(),
      E2E_HELPER_AGENT,
      base.projectId,
      randomUUID(),
      E2E_AUDITOR_AGENT,
      quarantineBase.projectId,
    ],
  );

  // Second flow: the graph manifest carrying the ai_coding `settings.agent`
  // binding (spec b), plus a Backlog task bound to it.
  const boundFlowSource = path.join(
    RUNTIME_ROOT,
    "flows",
    `${AGENTS_SLUG}-bound-flow`,
  );

  createLocalFlowSource(boundFlowSource);
  const boundRevisionId = randomUUID();
  const boundFlowId = randomUUID();
  const boundTaskId = randomUUID();

  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision, manifest_digest, manifest,
        schema_version, engine_min, installed_path, setup_status, package_status)
     VALUES ($1, 'agent-bound', $2, 'v0.0.1', $3, $4, $5, 1, '1.5.0', $6,
        'not_required', 'Installed')`,
    [
      boundRevisionId,
      boundFlowSource,
      randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40),
      `sha256:${boundRevisionId}`,
      JSON.stringify(AGENTS_BINDING_MANIFEST),
      boundFlowSource,
    ],
  );
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision, installed_path,
        manifest, schema_version, enabled_revision_id, enablement_state, trust_status)
     VALUES ($1, $2, 'agent-bound', $3, 'v0.0.1', $4, $3, $5, 1, $6,
        'Enabled', 'trusted_by_policy')`,
    [
      boundFlowId,
      base.projectId,
      boundFlowSource,
      boundRevisionId.replace(/-/g, "").padEnd(40, "0").slice(0, 40),
      JSON.stringify(AGENTS_BINDING_MANIFEST),
      boundRevisionId,
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2),
       'Bound-agent flow target', 'Run the agent-bound flow.', $3, 'Backlog', 'Backlog')`,
    [boundTaskId, base.projectId, boundFlowId],
  );
  const boundTaskNumber = Number(
    (await pool.query(`SELECT number FROM tasks WHERE id = $1`, [boundTaskId]))
      .rows[0].number,
  );

  return {
    ...base,
    helperAgentId: E2E_HELPER_AGENT,
    auditorAgentId: E2E_AUDITOR_AGENT,
    manualTaskId,
    manualTaskNumber,
    boundTaskId,
    boundTaskNumber,
    agentBodyMarker: AGENT_BODY_MARKER,
    agentsRoot,
    quarantine: {
      projectId: quarantineBase.projectId,
      projectSlug: quarantineBase.projectSlug,
      repoPath: quarantineBase.repoPath,
      taskId: quarantineBase.taskId!,
      taskNumber: quarantineTaskNumber,
    },
  };
}

// M37 (ADR-098): a launchable orchestrator flow + its delegate-target agent.
async function seedOrchestratorE2EFixture(
  pool: Pool,
  adminId: string,
): Promise<OrchestratorFixture> {
  const base = await seedLaunchableProjectFixture(pool, {
    slug: ORCHESTRATOR_SLUG,
    projectName: "E2E Orchestrator",
    userId: adminId,
    repoPath: path.join(RUNTIME_ROOT, "repos", ORCHESTRATOR_SLUG),
    task: {
      title: "Coordinate the delivery",
      prompt: "Break the delivery into sub-tasks and delegate them.",
      status: "Backlog",
      stage: "Backlog",
    },
  });

  // Override the default LINEAR_MANIFEST with the orchestrator-node graph on
  // BOTH the revision and the project flow row (loadRun reads flows.manifest;
  // the launch precondition compiles the revision manifest).
  await pool.query(
    `UPDATE flow_revisions SET manifest = $1, engine_min = '1.6.0'
     WHERE flow_ref_id = 'acceptance' AND installed_path = $2`,
    [
      JSON.stringify(ORCHESTRATOR_MANIFEST),
      path.join(RUNTIME_ROOT, "flows", `${ORCHESTRATOR_SLUG}-flow`),
    ],
  );
  await pool.query(`UPDATE flows SET manifest = $1 WHERE id = $2`, [
    JSON.stringify(ORCHESTRATOR_MANIFEST),
    base.flowId,
  ]);

  // The delegate-target worker agent (workspace=none → a delegated child
  // finalizes Done and emits run.done). Shipped as a package, pinned in the
  // project, attached to it — the same trust contour as platform-agents.
  const agentsRoot = path.join(RUNTIME_ROOT, "orc-agents");
  const workerPath = writeAgentDefinition({
    agentsRoot,
    id: E2E_WORKER_AGENT,
    workspace: "none",
    triggers: ["manual"],
    body: "You are an e2e delegated worker. Do the sub-task tersely.",
  });

  await pool.query(`DELETE FROM agents WHERE id = $1`, [E2E_WORKER_AGENT]);
  await pool.query(
    `INSERT INTO agents
       (id, package_name, version_label, origin, name, description, workspace,
        mode, triggers, risk_tier, source_path)
     VALUES ($1, 'e2e-orc-pkg', 'v1.0.0', 'git', $1, 'e2e worker agent', 'none',
        'session', '["manual"]'::jsonb, 'read_only', $2)`,
    [E2E_WORKER_AGENT, workerPath],
  );

  const orcPkgRevisionId = randomUUID();

  await pool.query(
    `DELETE FROM flow_revisions WHERE flow_ref_id = 'e2e-orc-pkg'`,
  );
  await pool.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision,
        manifest_digest, manifest, schema_version, installed_path, package_status)
     VALUES ($1, 'e2e-orc-pkg', 'github.com/maister/e2e-orc-pkg', 'v1.0.0',
             'rev-e2e-orc', 'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [orcPkgRevisionId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, installed_path,
        manifest, schema_version, enabled_revision_id, enablement_state,
        trust_status, version_binding)
     VALUES ($1, $2, 'e2e-orc-pkg', 'github.com/maister/e2e-orc-pkg', 'v1.0.0',
             $3, '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), base.projectId, agentsRoot, orcPkgRevisionId],
  );
  await pool.query(
    `INSERT INTO agent_project_links (id, agent_id, project_id) VALUES ($1, $2, $3)`,
    [randomUUID(), E2E_WORKER_AGENT, base.projectId],
  );

  const taskNumber = Number(
    (await pool.query(`SELECT number FROM tasks WHERE id = $1`, [base.taskId!]))
      .rows[0].number,
  );

  return {
    ...base,
    workerAgentId: E2E_WORKER_AGENT,
    taskNumber,
    agentsRoot,
  };
}

type M38DecideCase = {
  projectSlug: string;
  taskTitle: string;
  taskId: string;
  repoPath: string;
};

type M38DecideFixtureRecord = {
  route: M38DecideCase;
  mismatch: M38DecideCase;
  studio: { projectSlug: string; capId: string; nodeLabel: string };
};

// Seeds ONE launchable all-cli project per routing case. Reuses
// seedLaunchableProjectFixture (real git repo + Enabled/trusted/Installed
// `acceptance` flow + Backlog task), then overrides the flow manifest to the
// M38 decide/on_mismatch shape on BOTH the flow_revisions row (the launch
// precondition + runtime read it) and the flows row (loadRun/board read it),
// and writes the output schema doc into the flow's install dir.
async function seedM38DecideFixture(
  pool: Pool,
  adminId: string,
): Promise<M38DecideFixtureRecord> {
  async function seedCase(args: {
    slug: string;
    projectName: string;
    taskTitle: string;
    manifest: unknown;
  }): Promise<M38DecideCase> {
    const repoPath = path.join(RUNTIME_ROOT, "repos", args.slug);
    const base = await seedLaunchableProjectFixture(pool, {
      slug: args.slug,
      projectName: args.projectName,
      userId: adminId,
      repoPath,
      task: {
        title: args.taskTitle,
        prompt: "Exercise M38 decide/on_mismatch routing.",
        status: "Backlog",
        stage: "Backlog",
      },
    });

    const flowSource = path.join(RUNTIME_ROOT, "flows", `${args.slug}-flow`);

    // The output schema doc the runtime resolves relative to the flow install
    // dir (= flow_revisions.installed_path = flowSource).
    mkdirSync(path.join(flowSource, "schemas"), { recursive: true });
    writeFileSync(
      path.join(flowSource, "schemas", "result.json"),
      `${JSON.stringify(M38_RESULT_SCHEMA_DOC, null, 2)}\n`,
      "utf8",
    );

    // Override the LINEAR_MANIFEST default with the M38 graph on the enabled
    // revision (compiled by the launch precondition + read at runtime) and the
    // project flow row (read by loadRun + the board).
    await pool.query(
      `UPDATE flow_revisions SET manifest = $1, engine_min = '1.7.0'
       WHERE flow_ref_id = 'acceptance' AND installed_path = $2`,
      [JSON.stringify(args.manifest), flowSource],
    );
    await pool.query(`UPDATE flows SET manifest = $1 WHERE id = $2`, [
      JSON.stringify(args.manifest),
      base.flowId,
    ]);

    return {
      projectSlug: args.slug,
      taskTitle: args.taskTitle,
      taskId: base.taskId!,
      repoPath,
    };
  }

  const route = await seedCase({
    slug: M38_ROUTE_SLUG,
    projectName: "E2E M38 Decide Route",
    taskTitle: M38_ROUTE_TASK_TITLE,
    manifest: M38_ROUTE_MANIFEST,
  });
  const mismatch = await seedCase({
    slug: M38_MISMATCH_SLUG,
    projectName: "E2E M38 Mismatch Fail",
    taskTitle: M38_MISMATCH_TASK_TITLE,
    manifest: M38_MISMATCH_MANIFEST,
  });

  // Studio: a DRAFT authored flow (no repo/run) opened in the graph editor so
  // selecting the `classify` node renders the new Routing panel (the editor
  // reads the manifest from the authored revision; mirrors seedM27FlowEditorFixture).
  const studioIds = {
    project: randomUUID(),
    member: randomUUID(),
    cap: randomUUID(),
    revision: randomUUID(),
  };
  const studioRepoPath = `/tmp/maister-e2e/${studioIds.project}`;

  await pool.query(`DELETE FROM projects WHERE slug = $1`, [M38_STUDIO_SLUG]);
  await pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, $2, $3, $4, $5, 'E' || upper(substr(md5(random()::text), 1, 8)))`,
    [
      studioIds.project,
      M38_STUDIO_SLUG,
      "M38 Decide Studio (e2e)",
      studioRepoPath,
      `${studioRepoPath}/maister.yaml`,
    ],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [studioIds.member, studioIds.project, adminId],
  );

  const studioBody = {
    flowYaml: M38_STUDIO_FLOW_YAML,
    manifest: M38_STUDIO_MANIFEST,
    packageMetadata: { slug: M38_STUDIO_SLUG, name: "M38 Decide Studio" },
    files: [],
    validation: {
      status: "valid",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };

  await pool.query(
    `INSERT INTO authored_capabilities
       (id, project_id, kind, slug, title, lifecycle, draft_version,
        current_draft_revision_id)
     VALUES ($1, $2, 'flow', $3, $4, 'DRAFT', 1, $5)`,
    [
      studioIds.cap,
      studioIds.project,
      M38_STUDIO_SLUG,
      "M38 Decide Studio",
      studioIds.revision,
    ],
  );
  await pool.query(
    `INSERT INTO authored_capability_revisions
       (id, capability_id, project_id, kind, revision_number, lifecycle,
        draft_version, title, body, manifest, schema_version, content_hash)
     VALUES ($1, $2, $3, 'flow', 1, 'DRAFT', 1, $4, $5::jsonb, $6::jsonb, 1, $7)`,
    [
      studioIds.revision,
      studioIds.cap,
      studioIds.project,
      "M38 Decide Studio",
      JSON.stringify(studioBody),
      JSON.stringify(M38_STUDIO_MANIFEST),
      "m38-studio-seed",
    ],
  );

  return {
    route,
    mismatch,
    studio: {
      projectSlug: M38_STUDIO_SLUG,
      capId: studioIds.cap,
      nodeLabel: "Classify",
    },
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
        M12_SLUG,
        BOARD_SLUG,
        SCRATCH_SLUG,
        REGISTRATION_SLUG,
        REGISTRATION_DUP_SLUG,
        LIVE_CCR_SLUG,
        M11C_VISIBLE_SLUG,
        M11C_REFUSE_SLUG,
        M19_SLUG,
        M15_SLUG,
        M16_SLUG,
        M18_SLUG,
        M27_SLUG,
        M22_SLUG,
        M27_EDITOR_SLUG,
        FLOWS_AUTHORING_SLUG,
        RC_SLUG,
        FLOW_STUDIO_ARTIFACTS_SLUG,
        FLOW_VIEWER_SLUG,
        M38_ROUTE_SLUG,
        M38_MISMATCH_SLUG,
        M38_STUDIO_SLUG,
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
        M22_VIEWER_EMAIL,
        DELETABLE_EMAIL,
        MEMBER_CANDIDATE_EMAIL,
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
    // Unused pending account — no project_members rows → hard-delete eligible.
    const deletable = await insertUser(pool, {
      email: DELETABLE_EMAIL,
      password: DELETABLE_PASSWORD,
      name: "E2E Deletable",
      role: "member",
      accountStatus: "pending",
      mustChangePassword: false,
    });
    // Active member with no project membership — target for add/re-role/remove tests.
    const memberCandidate = await insertUser(pool, {
      email: MEMBER_CANDIDATE_EMAIL,
      password: MEMBER_CANDIDATE_PASSWORD,
      name: "E2E Member Candidate",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    });
    // Global-role `viewer` so it does NOT bypass project RBAC: it proves the
    // readRepoFiles `member` floor (viewer project member → 403).
    const m22Viewer = await insertUser(pool, {
      email: M22_VIEWER_EMAIL,
      password: M22_VIEWER_PASSWORD,
      name: "E2E M22 Viewer",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    });

    await seedPlatformRuntime(pool);

    const m11a = await seedM11aFixture(pool, admin.id);
    const m11b = await seedM11bFixture(pool, admin.id);
    const m12 = await seedM12EvidenceFixture(pool, admin.id);
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

    // ADR-083 social-board e2e fixture: a deterministic task key on the board
    // project (random elsewhere) plus a SECOND task to mention as EAB-2 from
    // a comment on EAB-1 (social-board.spec.ts).
    await pool.query(`UPDATE projects SET task_key = 'EAB' WHERE slug = $1`, [
      BOARD_SLUG,
    ]);
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       SELECT $1, p.id, 42,
              'Social mention target', 'Referenced from EAB-1 comments.', f.id, 'Backlog', 'Backlog'
       FROM projects p JOIN flows f ON f.project_id = p.id
       WHERE p.slug = $2`,
      [randomUUID(), BOARD_SLUG],
    );
    const scratch = await seedLaunchableProjectFixture(pool, {
      slug: SCRATCH_SLUG,
      projectName: "E2E Acceptance Scratch",
      userId: admin.id,
      repoPath: path.join(RUNTIME_ROOT, "repos", SCRATCH_SLUG),
      defaultRunnerId: CODEX_RUNNER_ID,
    });

    // FR-D: a project skill so the launcher's CapabilityComposer autocomplete
    // has a `/`-triggerable entry (scratch-composer.spec).
    await pool.query(
      `INSERT INTO capability_records
         (id, project_id, capability_ref_id, kind, label, source, agents, material)
       SELECT $1, p.id, 'aif-plan', 'skill', 'AIF Plan', 'flow-package',
         '["claude","codex"]'::jsonb,
         '{"description":"Plan a feature","argHint":"<feature>"}'::jsonb
       FROM projects p WHERE p.slug = $2`,
      [randomUUID(), SCRATCH_SLUG],
    );
    const liveCcr = await seedLaunchableProjectFixture(pool, {
      slug: LIVE_CCR_SLUG,
      projectName: "E2E Live CCR",
      userId: admin.id,
      repoPath: path.join(RUNTIME_ROOT, "repos", LIVE_CCR_SLUG),
      defaultRunnerId: CCR_RUNNER_ID,
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
    const m15 = await seedM15Fixture(pool, admin.id);
    const m16 = await seedM16Fixture(pool, admin.id);
    const m17 = await seedM17Fixture(pool, admin.id);
    const budgetFork = await seedBudgetForkFixture(pool, admin.id);
    const m18 = await seedM18Fixture(pool, admin.id);
    const m27 = await seedM27Fixture(pool, admin.id);
    const m22 = await seedM22Fixture(pool, admin.id, m22Viewer);
    const scratchDetail = await seedScratchDetailFixture(pool, admin.id);
    const m23 = await seedM23Fixture(pool, admin.id);
    const m27Editor = await seedM27FlowEditorFixture(pool, admin.id);
    const flowsAuthoring = await seedFlowsAuthoringFixture(pool, admin.id);
    const reviewComments = await seedReviewCommentsFixture(pool, admin);
    const flowStudioArtifacts = await seedFlowStudioArtifactsFixture(
      pool,
      admin.id,
    );
    const flowViewer = await seedInstalledPackageFixture(pool, admin.id);
    const platformAgents = await seedPlatformAgentsFixture(pool, admin.id);
    const orchestrator = await seedOrchestratorE2EFixture(pool, admin.id);
    const m38 = await seedM38DecideFixture(pool, admin.id);
    const m40 = await seedM40Fixture(pool, admin.id);

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
        deletable,
        memberCandidate,
      },
      byKey: {
        m11a,
        m11b,
        m12,
        board,
        scratch,
        liveCcr,
        registration,
        m11cVisible,
        m11cRefuse,
        m19,
        m15,
        m16,
        m17,
        budgetFork,
        m18,
        m27,
        m22,
        scratchDetail,
        m23,
        m27Editor,
        flowsAuthoring,
        reviewComments,
        flowStudioArtifacts,
        flowViewer,
        platformAgents,
        orchestrator,
        m38,
        m40,
      },
    };
    const outDir = path.resolve("e2e/.auth");

    // ADR-078 D1: raw-SQL task fixtures above do not advance the per-project
    // allocation counter — reconcile every project so runtime createTask
    // never collides with a seeded number.
    await pool.query(
      `UPDATE projects p
       SET next_task_number = GREATEST(
         p.next_task_number,
         COALESCE((SELECT MAX(t.number) + 1 FROM tasks t WHERE t.project_id = p.id), 1)
       )`,
    );

    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "fixtures.json"),
      `${JSON.stringify(fixtures, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `seed-e2e: seeded m11a ${m11a.runId}, m11b ${m11b.runId}, m12 ${m12.runId} (${M12_SLUG}), board ${board.projectSlug}, scratch ${scratch.projectSlug}` +
        `, m11c-visible ${m11cVisible.runId} (${M11C_VISIBLE_SLUG}), m11c-refuse ${m11cRefuse.taskId} (${M11C_REFUSE_SLUG})` +
        `, m19 crashed ${m19.crashedRunId} (${M19_SLUG})` +
        `, m15 failed ${m15.failedRunId} overridden ${m15.overriddenRunId} (${M15_SLUG})` +
        `, m16 run ${m16.runId} gate ${m16.gateId} (${M16_SLUG})` +
        `, m17 proj1 ${m17.project1RunId} proj2 ${m17.project2RunId} (${M17_PROJECT1_SLUG}, ${M17_PROJECT2_SLUG})` +
        `, budget-fork ${budgetFork.runId} (${BUDGET_FORK_SLUG})` +
        `, m18 merge ${m18.mergeRunId} conflict ${m18.conflictRunId} pr ${m18.prRunId} (${M18_SLUG})` +
        `, m27 flow ${m27.flowRunId} scratch ${m27.scratchRunId} (${M27_SLUG})` +
        `, m22 run ${m22.runId} (${M22_SLUG})` +
        `, scratch-detail ${scratchDetail.scratchRunId} (${SCRATCH_DETAIL_SLUG})` +
        `, m23 project ${m23.projectSlug}` +
        `, flows-authoring cap ${flowsAuthoring.capId} (${FLOWS_AUTHORING_SLUG})` +
        `, review-comments ${reviewComments.runId} (${RC_SLUG})` +
        `, flow-studio-artifacts cap ${flowStudioArtifacts.capId} (${FLOW_STUDIO_ARTIFACTS_SLUG})` +
        `, flow-viewer ref ${flowViewer.flowRefId} (${FLOW_VIEWER_SLUG})` +
        `, platform-agents ${platformAgents.helperAgentId}/${platformAgents.auditorAgentId} (${AGENTS_SLUG})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-e2e failed:", err);
  process.exit(1);
});
