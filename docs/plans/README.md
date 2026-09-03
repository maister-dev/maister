# Design docs (`docs/plans/`)

Dated point-in-time design/brainstorm documents that fed implementation
plans. They are **historical records**: every file carries a mandatory
`Status` header near the top (kept current — Shipped / Partial with the
remainder named / Superseded by …), and current behavior truth always lives
in [`../system-analytics/`](../system-analytics/) and the ADR log, never
here. Do not delete shipped plans (several are cited from code and ADRs);
do not start new work from one without checking its status header first.

This table is the canonical index of the folder (`pnpm validate:docs`
fails when a file here is missing from it).

| File | Status |
| ---- | ------ |
| [`2026-06-08-aif-flow-package-design.md`](2026-06-08-aif-flow-package-design.md) | Shipped (as-built deltas of 2026-06-09 inside) |
| [`2026-06-13-web-shell-and-nav-unlock-design.md`](2026-06-13-web-shell-and-nav-unlock-design.md) | Shipped (WI-1…WI-6); the `supported_agents` readiness-gating follow-up shipped 2026-08-31 |
| [`2026-06-15-flow-studio-redesign.md`](2026-06-15-flow-studio-redesign.md) | Shipped — Phase B = M35, Phase C = M36; git write-back landed as ADR-113/132 |
| [`2026-06-16-active-workspaces-rail-actions-design.md`](2026-06-16-active-workspaces-rail-actions-design.md) | Implemented (2026-06-16) |
| [`2026-06-16-run-task-context-visibility-design.md`](2026-06-16-run-task-context-visibility-design.md) | Shipped (migration 0053, identity-first run card) |
| [`2026-06-16-unified-capability-composer-design.md`](2026-06-16-unified-capability-composer-design.md) | Shipped (composer + per-adapter materialization); the §8 promotion-UX question stays open  |
| [`2026-06-17-add-project-onboarding-and-git-access-design.md`](2026-06-17-add-project-onboarding-and-git-access-design.md) | Shipped (P1+P2+P3, ADR-093) |
| [`2026-06-17-phase6-launch-progress-streaming-subplan.md`](2026-06-17-phase6-launch-progress-streaming-subplan.md) | Shipped (incl |
| [`2026-06-18-execution-control-policy-design.md`](2026-06-18-execution-control-policy-design.md) | Shipped (ADR-095; budget axis followed as ADR-101) |
| [`2026-06-18-flow-execution-control-policy-plan.md`](2026-06-18-flow-execution-control-policy-plan.md) | Shipped — all A/B/C/spend axes |
| [`2026-06-20-flow-package-viewer-and-local-editing-design.md`](2026-06-20-flow-package-viewer-and-local-editing-design.md) | Shipped (all 5 milestones; current truth ` |
| [`2026-06-21-cost-budget-governance-design.md`](2026-06-21-cost-budget-governance-design.md) | Shipped (ADR-101, migration 0061; `budget_ceiling_override` folded into `budget_state` as- |
| [`2026-06-21-platform-agents-vs-subagents-design.md`](2026-06-21-platform-agents-vs-subagents-design.md) | Shipped (registry scans `maister-agents/`; platform-agent inventory in attachments) |
| [`2026-06-21-shared-worktree-review-model-design.md`](2026-06-21-shared-worktree-review-model-design.md) | Shipped as ADR-102 (current truth: ` |
| [`2026-06-26-node-form-reference-pickers-plan.md`](2026-06-26-node-form-reference-pickers-plan.md) | Shipped (Phases 0/A/B/C) |
| [`2026-07-01-project-brain-architecture.md`](2026-07-01-project-brain-architecture.md) | Shipped — sub-projects A/B/C all landed (ADR-122/127/128) |
| [`2026-09-02-rah-companion-package.md`](2026-09-02-rah-companion-package.md) | Pending — handoff pointer for `maister-plugins/packages/rah` (ADR-165); authored after this repo merges |
