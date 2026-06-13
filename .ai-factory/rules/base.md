# MAIster — Base Rules

> Project-wide conventions detected from existing code, `CLAUDE.md`, and
> `web/CLAUDE.md`. These are baseline rules; area-specific rules can live
> under `.ai-factory/rules/<area>.md` and override these on conflict.
>
> Authoritative sources: `CLAUDE.md` and `web/CLAUDE.md` win on conflict —
> update this file when those change.

## Language & Build

- **TypeScript end-to-end**, `strict: true`. No `any` in committed code
  unless flagged with `// FIXME(any):` and justified inline.
- Python only as a subprocess (`uv run aif ...`) — never as in-process
  binding.
- Imports rooted at `web/` use the `@/...` alias. Never deep relative
  (`../../..`).
- Package manager: **pnpm**. Do not introduce npm/yarn lockfiles.

## Naming & Files

- React components: `kebab-case.tsx` file, named exports preferred.
- Route handlers: `app/api/<segment>/route.ts`, exporting `GET` / `POST` etc.
- Server-only modules importing `node:*` or secrets: keep under `lib/` and
  never import from a Client Component.
- Server actions and Route Handlers stay under `app/`. Keep secret-touching
  logic server-side.

## Module Structure

- `web/` is the Next.js control plane:
  UI + Route Handlers + server actions + Drizzle DB + SSE bridge.
- Suggested server-side module layout under `web/lib/` (introduce as
  needed, do not pre-scaffold):
  - `lib/errors.ts` — `MaisterError` discriminated union.
  - `lib/atomic.ts` — `atomicWriteJson` (tmp + rename).
  - `lib/worktree.ts` — `git worktree add | remove | list` wrapper
    (project-scoped paths).
  - `lib/config.ts` — `maister.yaml` v2 loader (`project` + `executors[]` + `flows[]`),
    `schemaVersion` check, slug derivation, duplicate-flow-id check,
    zod-validated.
  - `lib/projects.ts` — project registry CRUD +
    `MAISTER_PROJECTS_DIR` auto-discovery.
  - `lib/scheduler.ts` — global concurrency cap
    (`MAISTER_MAX_CONCURRENT_RUNS`), Pending queue, auto-promote.
  - `lib/db/` — Drizzle schema (`projects`, `executors`, `flows`, `tasks`,
    `runs`, `workspaces`, `step_runs`, `hitl_requests`) + client.
  - `lib/reconcile.ts` — startup hook: per-project `runs` vs
    `git worktree list`; orphaned `Running` → `Crashed`.

## Error Handling

- Throw `MaisterError` with a discriminated `code`
  (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
  CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL | CHECKPOINT`)
  for known domain failures. UI branches on `code`, never on string
  matching.
- Never wrap plain `Error` to "look typed". If you need a new error type,
  add it to the `MaisterError` taxonomy.
- Do not add error handling, fallbacks, or validation for scenarios that
  can't happen. Trust internal code and framework guarantees. Validate only
  at system boundaries (user input, external APIs, subprocess exits, file
  reads from disk).

## Atomic Writes

- All writes under `.maister/<project-slug>/runs/<run-id>/` are **atomic**:
  tmp file + rename via `atomicWriteJson`. Flow may read these files
  mid-write otherwise.
- Never partial-write JSON that the Flow will consume.

## Subprocess & Concurrency

- Agent processes are owned by `supervisor/`, not `web/`. Permission HITL
  resolves through supervisor deferreds; form/human HITL resumes through
  durable input artifacts.
- No `chokidar`, no `fs.watch`, no polling for state transitions.
- Default concurrency cap: `MAISTER_MAX_CONCURRENT_RUNS=6` (env-configurable,
  **global** across all projects, not per-project). Runs above the cap go to
  `Pending` and auto-start on slot free. UI shows queue position.

## SSE / Logging

- Supervisor emits structured session events with monotonic ids and also
  writes raw step logs. Web run SSE tails durable `run.events.jsonl`.
- Eslint rule `no-console: warn` is enforced. Use a logger boundary; do not
  ship `console.log` in committed code.

## React / Next.js

- Default to **Server Components**. Add `"use client"` only when a
  component uses state, effects, browser APIs, or HeroUI components that
  require client context.
- Default theme is `dark`.
- Use HeroUI components (`Button`, `Card`, `Modal`, `Input`, `Navbar`, etc.)
  instead of hand-rolling. No other component library
  (no shadcn/ui, no MUI, no Chakra).
- Styling: Tailwind 4 utility classes. For variant-based class composition
  use `tailwind-variants` (`tv(...)`), mirroring
  `components/primitives.ts`. Use `clsx` for ad-hoc combos.

## Linting (auto-enforced by `pnpm lint`)

- `no-console`: warn.
- `react/jsx-sort-props`: callbacks last, shorthand first, reserved first.
- `import/order`: type → builtin → object → external → internal → parent →
  sibling → index, with blank lines between.
- `padding-line-between-statements`: blank line before `return`; blank line
  after `const/let/var` blocks.
- `unused-imports/no-unused-imports`: warn.
- `react/self-closing-comp`: warn.

## Comments

- **Default: no comments.** Only add a comment when the WHY is non-obvious
  (a hidden invariant, a workaround for a specific bug, a surprising
  constraint).
- Do not explain WHAT the code does — well-named identifiers do that.
- Do not reference the current task, fix, or callers
  (`// used by X`, `// added for the Y flow`, `// handles issue #123`).
  Those belong in the PR description and rot as the codebase evolves.

## Surgical Changes

- Every changed line must trace directly to the user's request.
- Do not refactor adjacent code "while you're there".
- Do not "improve" comments, formatting, or naming you weren't asked to
  touch.
- Match existing style, even if you'd do it differently.
- Unrelated dead code: mention it in the PR description, don't delete it
  unless asked.

## Security

- Server-only secrets are read from `.env` server-side. **Never** logged,
  **never** streamed via SSE, **never** sent to client.
- API keys and tokens must not appear in subprocess argv or environment
  visible to the frontend.

## Scope Labels

`Implemented`, `Designed`, and `Phase 2` are planning labels, not hard
blockers. Large features such as Flow designer UI, background agents,
Telegram, AI-Judge, guard enforcement, trust UI, extra executors, and
team/RBAC support need an explicit plan and contract updates before
implementation.
