# Project Roadmap

> MAIster — the control plane for AI-powered software delivery. Multi-project, multi-workspace web shell over ACP-driven agent execution, structured HITL, Flow-plugin engine, and per-project task boards.

## Milestones

- [x] **M0. Spike: ACP library + cross-process resume + codex parity** — completed 2026-05-25. Full findings in `docs/kaa-maister-m0-spike-findings-20260525.md`. Verdicts: (a) `@agentclientprotocol/claude-agent-acp@0.37.0` + `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1` (Apache-2.0) — pin in `supervisor/package.json`; (b) cross-process `claude --resume <uuid>` ✅ verified live ("ALBATROSS-42" round-trip), sessions at `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`; (c) codex via `codex-acp` adapter binary (bundles `@openai/codex` 0.128+), supervisor spawn dispatches on `executor.agent`; (d) z.ai works as plain env-router (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + `ANTHROPIC_AUTH_TOKEN`) — CCR is multi-provider intelligent routing, optional. **NEW finding**: each respawn rebuilds ~$0.28 of cache_creation tokens → 30-min keep-alive design saves real money, not just UX.

- [ ] **M1. Drizzle schema + Postgres** — tables `projects | tasks | runs | workspaces | hitl_requests | flows | executors`. New fields: `runs.executor_id`, `runs.acp_session_id`, `runs.flow_version`, `runs.checkpoint_at`, `tasks.attempt_number` UNIQUE per task. Docker compose for Postgres 16, migrations, seed.

- [ ] **M2. Core libs (errors, atomic, config v2)** — `MaisterError` taxonomy with new codes (`EXECUTOR_UNAVAILABLE`, `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`). `atomicWriteJson`. `maister.yaml` v2 loader (`project` + `executors[]` + `flows[]` with version pins). Flow manifest (`flow.yaml`) schema validator.

- [ ] **M3. Supervisor daemon (`supervisor/`)** — separate Node process. HTTP+SSE API: `POST /sessions`, `DELETE /sessions/:id`, `GET /sessions/:id/stream`. Process-per-session spawn (claude/codex), heartbeat watcher → `Crashed`, token-count → cost metric persisted to `.maister/<slug>/runs/<id>/cost.jsonl`. Designed to run on a different host than Next.js (HTTP IPC).

- [ ] **M4. Flow plugin loader** — git pull by URL + version tag → `~/.maister/flows/<id>@<tag>/` system cache → per-project symlink in `.maister/<slug>/flows/`. Manifest validation, version pin in project's `maister.yaml`. Trust all sources on POC (internal Flows only; sandboxing is Phase 2). **First plugin under development: `superpowers`** (skills-only, simplest path to prove the loader + manifest + slash-command-step shape without `setup.sh` drag).

- [ ] **M5. Flow DSL parser + executor** — step types `cli | agent | guard | human`. Pre/post guards. Full templating with session context + cross-step vars + observability traces. Both `slash-in-existing-session` and `new-session-per-step` modes for `agent` step. Cost/time/regex guard fields **parsed and persisted** (metrics-on-disk only — no enforcement on POC). **Second plugin: `aif`** — wraps `/aif-explore`, `/aif-plan`, `/aif-implement`, `/aif-fix` as slash-in-existing-session steps + `setup.sh` running `ai-factory init`; validates the full plugin surface including shipped-CLI install.

- [ ] **M6. Executor registry: claude + codex + CCR** — executor identity `{agent, model, env?, router?}` persisted in `executors` table. CCR (Claude Code Router) bundled out-of-the-box for `router: ccr` (z.ai GLM, MiniMax, etc.). Per-step override resolution: Flow recommends → project default → project override → run launcher override.

- [ ] **M7. ACP integration + SSE bridge** — supervisor speaks Zed-standard ACP (no custom extensions on POC; extensions tracked in Phase 2 backlog). `session/update` → SSE → Next.js → browser. `session/request_permission` for binary approve/deny HITL. Structured-form HITL via artifact (`needs-input.json`) — hybrid live + durable.

- [ ] **M8. Worker lifecycle: keep-alive + checkpoint + resume** — ACP session keep-alive during `NeedsInput` up to 30 min. Each web-console activity from the user (open run page, focus, type) extends window by 30 min. On idle timeout → graceful checkpoint → process dies → state `NeedsInputIdle`. User input arrival → respawn via `--resume <session-id>`. Run states: `Pending | Running | NeedsInput | NeedsInputIdle | Review | Crashed | Done | Abandoned | Failed`.

- [ ] **M9. Web UI core: registry + portfolio + board + RU i18n** — replace HeroUI template stubs. Add Project form (paste maister.yaml dir), Projects list, Portfolio home grid (superset.sh-style), per-project board `Backlog | In Flight`, Launch button, task↔run 1:N retry loop. EN+RU i18n from day one (no English-only milestone).

- [ ] **M10. HITL hybrid surface** — in-card form on task card (delivered via artifact + ACP notification), "Needs you (N)" badge on portfolio home, dedicated Inbox block listing pending HITL requests across all projects. `human` step type renders with review / send-back-with-comments flow that loops `goto_step` with `comments_var` set.

- [ ] **M11. Diff view + merge-to-main** — raw `git diff` in `<pre>` (no syntax highlighting on POC), `git merge --no-ff` on parent's `main_branch`, `MaisterError({code: 'CONFLICT'})` aborts merge and surfaces "resolve manually" with parent repo path.

- [ ] **M12. Reconciliation + GC** — startup hook: per-project runs vs `git worktree list`, orphan `Running` → `Crashed`. Supervisor heartbeat: dead worker mid-`Running` → `Crashed`. Cron route: GC `Abandoned/Done` worktrees + checkpointed sessions older than 7d. "Recover or discard" UI for Crashed runs.

- [ ] **M13. Dogfood + external validation** — register MAIster repo in itself, ship ≥1 non-trivial PR through the **aif Flow plugin** against own backlog (validates aif-as-plugin end-to-end + retry loop on a real task). Then onboard 3 installations on external repos using either `aif` or `superpowers` plugins, ≥1 PR shipped end-to-end on each within T+21d after dogfood. 0/3 → thesis not validated, reassess wedge.

## Completed

| Milestone | Date |
|-----------|------|
| M0. Spike: ACP library + cross-process resume + codex parity | 2026-05-25 |
