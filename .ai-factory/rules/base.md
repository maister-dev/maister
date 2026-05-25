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

- `web/` is the entire app for the POC (Next.js 16 monolith):
  UI + Route Handlers + server actions + subprocess runner + Drizzle DB +
  SSE log streams.
- Suggested server-side module layout under `web/lib/` (introduce as
  needed, do not pre-scaffold):
  - `lib/errors.ts` — `MaisterError` discriminated union.
  - `lib/atomic.ts` — `atomicWriteJson` (tmp + rename).
  - `lib/worktree.ts` — `git worktree add | remove | list` wrapper
    (project-scoped paths).
  - `lib/runner.ts` — `child_process.spawn` of `uv run <flow-cmd>`; pipes
    stdout to SSE **and** to disk simultaneously, under the project subtree.
  - `lib/config.ts` — `maister.yaml` v1 loader (`project` + `flows[]`),
    `schemaVersion` check, slug derivation, duplicate-flow-id check,
    zod-validated.
  - `lib/projects.ts` — project registry CRUD +
    `MAISTER_PROJECTS_DIR` auto-discovery.
  - `lib/scheduler.ts` — global concurrency cap
    (`MAISTER_MAX_CONCURRENT_RUNS`), Pending queue, auto-promote.
  - `lib/db/` — Drizzle schema (`projects`, `tasks`, `runs`, `workspaces`,
    `hitl_requests`) + client.
  - `lib/reconcile.ts` — startup hook: per-project `runs` vs
    `git worktree list`; orphaned `Running` → `Crashed`.

## Error Handling

- Throw `MaisterError` with a discriminated `code`
  (`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
  CONFIG`) for known domain failures. UI branches on `code`, never on string
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

- One **block** = one subprocess invocation that runs to natural exit. No
  long-running process held across a HITL wait.
- No `chokidar`, no `fs.watch`, no polling. Subprocess exit codes drive UI
  state transitions.
- Block exit conventions:
  - Exit 0, no artifact → block done, advance.
  - Exit 0 + `.maister/<project-slug>/runs/<run-id>/needs-input.json` →
    run state `Needs input`.
  - Exit ≠ 0 → run state `Failed`.
- POC concurrency cap: `MAISTER_MAX_CONCURRENT_RUNS=3` (env-configurable,
  **global** across all projects, not per-project). Runs above the cap go to
  `Pending` and auto-start on slot free. UI shows queue position.

## SSE / Logging

- One SSE message per stdout line. Include monotonic `id` for
  `lastEventId` reconnect.
- Stdout is streamed to disk
  (`.maister/<project-slug>/runs/<run-id>/<block-id>.log`) via
  `fs.createWriteStream` **in parallel** with SSE emission. Read-side tails
  the file.
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

## Out-of-POC Guard

Push back with "out of POC scope" and link to
`docs/kaa-maister-design-20260522-174429.md` §"Out of POC (explicit)" if a
task tries to add: Flow designer UI · multi-executor pool · adapter
interface · background agents (reviewer / log / dependency) · Telegram ·
A/B parallel runs · durable orchestration · auth / multi-user / RBAC ·
AI-Judge · full Kanban (Done as drag-target / WIP limits / swim-lanes) ·
event log table · test-run UI button · GitHub Actions CI/CD · syntax
highlighting in diff view · skills invocation (read-only enumeration
only) · project archival UI · cross-project task moves · external
issue-tracker sync · project lesson capture.
