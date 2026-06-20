import { readFileSync } from "node:fs";
import path from "node:path";

export type E2EUserFixture = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export type E2EProjectFixture = {
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

// M34 platform-agents fixture (ADR-089): manual launch, flow binding,
// repo_read quarantine.
export type E2EPlatformAgentsFixture = E2EProjectFixture & {
  helperAgentId: string;
  auditorAgentId: string;
  manualTaskId: string;
  manualTaskNumber: number;
  boundTaskId: string;
  boundTaskNumber: number;
  agentBodyMarker: string;
  agentsRoot: string;
  quarantine: {
    projectId: string;
    projectSlug: string;
    repoPath: string;
    taskId: string;
    taskNumber: number;
  };
};

// M36 (ADR-095) orchestrator-loop fixture: a launchable orchestrator flow + its
// delegate-target worker agent.
export type E2EOrchestratorFixture = E2EProjectFixture & {
  workerAgentId: string;
  taskNumber: number;
  agentsRoot: string;
};

export type E2ERegistrationFixture = {
  repoPath: string;
  duplicateRepoPath: string;
  expectedSlug: string;
  duplicateSlug: string;
};

// M16 Phase 8: external-operations API fixture. ONE project carrying both:
//   • a LAUNCHABLE Backlog task (full on-disk git repo + enabled flow revision)
//     so the token-authed task-create + run-launch reach a real 201/202; and
//   • a review run parked at a `review` human node whose pre_finish declares a
//     BLOCKING external_check gate seeded `pending` (gate_results) — the vehicle
//     for the readiness / gate-report / re-stale / evidence steps with no agent.
export type E2EM16Fixture = E2EProjectFixture & {
  // The launchable Backlog task (token-auth task-create + run-launch targets).
  launchTaskId: string;
  // The seeded parked-review run + its external_check gate.
  runId: string;
  hitlRequestId: string;
  gateId: string;
};

// M17 Phase 7: HITL hybrid-surface e2e fixture. Two projects carrying:
//   • Project 1: a NeedsInput run with a human_review HITL (criticality: high)
//   • Project 2: a NeedsInput run with a human_review HITL (criticality: medium, on_reject schema)
// Exercises cross-project inbox, inline response controls, confidence input, criticality badges.
export type E2EM17Fixture = {
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

export type E2EM23Fixture = {
  projectId: string;
  projectSlug: string;
  flowId: string;
  nodeId: string;
};

// M19 Phase 5: reconcile + GC UI fixture. One project carrying:
//   • a Crashed flow run with an acpSessionId checkpoint + an ai_coding current
//     node → recoverable: true (run-detail crashed section + board Crashed col);
//   • two terminal Abandoned runs whose workspaces have a staggered
//     scheduled_removal_at — one inside the warning window, one already due —
//     for the left-rail TTL badge (ttlState warning / due).
export type E2EM19Fixture = {
  projectId: string;
  projectSlug: string;
  repoPath: string;
  // The recoverable Crashed flow run (run-detail + board Crashed column).
  crashedRunId: string;
  crashedBranch: string;
  // Abandoned run whose workspace removal is inside the warning window.
  warningRunId: string;
  warningBranch: string;
  // Abandoned run whose workspace removal deadline is already past (due).
  dueRunId: string;
  dueBranch: string;
};

// M22 Phase 6: workbench fixture. ONE project with a REAL repo (tracked files +
// an oversized blob + a committed run-branch diff) and a flow run parked at
// Running with current_step_id = the `implement` node. Carries the seeded VIEWER
// credentials to prove the readRepoFiles member-gate (viewer → 403).
export type E2EM22Fixture = {
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

export type E2EFixtures = {
  adminEmail: string;
  adminPassword: string;
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  users: {
    admin: E2EUserFixture;
    mustChange: E2EUserFixture;
    pending: E2EUserFixture;
    disabled: E2EUserFixture;
    member: E2EUserFixture;
    editTarget: E2EUserFixture;
    deletable: E2EUserFixture;
    memberCandidate: E2EUserFixture;
  };
  byKey: {
    m11a: E2EProjectFixture;
    m11b: E2EProjectFixture;
    board: E2EProjectFixture;
    scratch: E2EProjectFixture;
    liveCcr: E2EProjectFixture;
    registration: E2ERegistrationFixture;
    m17: E2EM17Fixture;
    m19: E2EM19Fixture;
    m16: E2EM16Fixture;
    m22: E2EM22Fixture;
    m23: E2EM23Fixture;
    platformAgents: E2EPlatformAgentsFixture;
    orchestrator: E2EOrchestratorFixture;
  };
};

export function loadFixtures(): E2EFixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as E2EFixtures;
}
