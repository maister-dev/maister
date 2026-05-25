# Architecture: Structured Modules (Technical Layers)

## Overview

MAIster's POC is a **Next.js 16 monolith** in `web/`: UI + Route Handlers +
server actions + (eventually) Drizzle DB access + subprocess runner + SSE log
streams in one process. The architecture pattern is **Structured Modules with
technical-layer organization**, adapted to the Next.js App Router shape.

Two organizational axes coexist:

1. **Feature-folder routes** under `app/` (App Router convention): each
   user-visible area — `(portfolio)` (home grid), `projects`, `projects/[slug]`
   (board), `runs`, settings — gets its own folder with pages, server actions,
   and Route Handlers.
2. **Technical-layer modules** under `lib/`: cross-cutting infrastructure
   (`errors`, `atomic`, `worktree`, `runner`, `config`, `projects`,
   `scheduler`, `db`, `reconcile`) organized by concern, not by feature.

This honors the locked structure in `web/CLAUDE.md` without bolting on
ceremony the POC doesn't need. Migration to **Explicit Architecture** stays
trivial later: `lib/db/` becomes Infrastructure, the `MaisterError` taxonomy
becomes Domain, and use-case services move out of Route Handlers into an
Application layer.

## Decision Rationale

- **Project type:** Web control plane (Next.js 16 monolith, single host,
  single user POC).
- **Tech stack:** Next.js 16 App Router · TypeScript 5.6 (strict) · HeroUI v3
  · Tailwind 4 · Drizzle ORM · Postgres 16 · Node `child_process.spawn` ·
  pnpm.
- **Team size:** 1 (solo dev).
- **Domain complexity:** Medium — multi-project registry, workspace lifecycle,
  block-based HITL state machine, SSE pipe-to-disk, subprocess reconciliation,
  global concurrency scheduler.
- **Scale:** POC, single host, `MAISTER_MAX_CONCURRENT_RUNS=3` (global cap).
- **Key factors:**
  - Fast initial velocity required (T+1.5 weeks to working end-to-end).
  - Hard "no premature abstraction" rule in `CLAUDE.md` (§5: single
    executor hard-coded; §"Out of POC scope" forbids adapter interface).
  - Next.js App Router already enforces feature-folder layout for routes,
    so adding bounded contexts on top would duplicate structure.
  - Cross-cutting concerns (errors, atomic writes, subprocess, git
    worktree) are technical, not domain — natural fit for `lib/` modules
    organized by concern.

Why not Layered? The project has 5 entities (`projects`, `tasks`, `runs`,
`workspaces`, `hitl_requests`) with non-trivial invariants (multi-project
registry, HITL state machine, worktree lifecycle, global concurrency
scheduler). A flat `src/services/`, `src/controllers/` layout would mix
unrelated logic as soon as the POC grows.

Why not Explicit Architecture? Decision matrix puts it at team size 5-30 and
"high" domain complexity. Out-of-POC scope rule forbids adapter interfaces.
Domain logic is small enough that Domain/Application/Infrastructure
separation would add ceremony without payoff.

Why not Microservices? Explicitly out of POC scope per `CLAUDE.md`. No
separate backend service.

## Folder Structure

```
mAIster/
├── .ai-factory/                    # AI Factory context (this doc lives here)
├── .maister/                       # Runtime artifacts (NOT committed)
│   └── <project-slug>/             # One subtree per registered project
│       └── runs/<run-id>/
│           ├── <block-id>.log      # SSE pipe-to-disk
│           ├── needs-input.json    # HITL signal from Flow
│           └── input-<block-id>.json   # HITL response (atomic write)
├── docs/                           # Product + engineering docs
└── web/                            # The entire MAIster app (Next.js monolith)
    ├── app/                        # ── ROUTES & PRESENTATION (feature folders) ──
    │   ├── layout.tsx              # Root layout (Providers + Navbar w/ project switcher)
    │   ├── page.tsx                # Portfolio home (superset.sh-style grid)
    │   ├── projects/
    │   │   ├── page.tsx            # Projects list + "Add project" button
    │   │   ├── new/page.tsx        # Add-project form (paste maister.yaml dir)
    │   │   └── [slug]/
    │   │       ├── page.tsx        # Per-project board (Backlog | In Flight)
    │   │       ├── actions.ts      # Server actions: create-task, launch (button click), discard-task
    │   │       ├── components/     # Board-local components (columns, cards, Launch button)
    │   │       └── tasks/
    │   │           └── new/page.tsx # Task creation: title + prompt + Flow dropdown
    │   ├── runs/
    │   │   └── [id]/
    │   │       ├── page.tsx        # Run detail: status + logs + HITL + diff
    │   │       ├── actions.ts      # Server actions: mark-ready, merge, abandon
    │   │       └── components/     # Run-detail-local components
    │   └── api/                    # ── ROUTE HANDLERS (controllers) ──
    │       ├── projects/
    │       │   ├── route.ts                  # POST /api/projects (register)
    │       │   └── [slug]/
    │       │       ├── route.ts              # DELETE (soft-archive)
    │       │       └── tasks/route.ts        # POST tasks (per-project)
    │       ├── runs/
    │       │   ├── route.ts                  # POST /api/runs (preconditions + spawn)
    │       │   └── [id]/
    │       │       ├── stream/route.ts       # GET SSE
    │       │       ├── hitl-response/route.ts # POST HITL response
    │       │       ├── diff/route.ts         # GET git diff
    │       │       ├── merge/route.ts        # POST git merge --no-ff
    │       │       └── abandon/route.ts      # POST abandon
    │       └── cron/
    │           └── gc/route.ts               # GET worktree GC (all projects)
    │
    ├── components/                 # ── SHARED PRESENTATION COMPONENTS ──
    │   ├── navbar.tsx              # HeroUI Navbar + project switcher
    │   ├── theme-switch.tsx        # next-themes toggle
    │   ├── icons.tsx               # Inline SVG icons
    │   ├── primitives.ts           # tailwind-variants title()/subtitle()
    │   ├── portfolio-card.tsx      # Workspace card on portfolio home
    │   ├── board-column.tsx        # Board column (Backlog / In Flight)
    │   └── task-card.tsx           # Task card on board (carries Launch button when in Backlog)
    │
    ├── config/                     # ── SITE-LEVEL CONFIG (static) ──
    │   ├── site.ts                 # navItems (Portfolio/Projects/Settings)
    │   └── fonts.ts                # Inter + Fira Code via next/font
    │
    ├── lib/                        # ── TECHNICAL-LAYER MODULES (server-only) ──
    │   ├── errors.ts               # MaisterError discriminated union
    │   ├── atomic.ts               # atomicWriteJson (tmp + rename)
    │   ├── worktree.ts             # git worktree add/remove/list wrapper (project-scoped paths)
    │   ├── runner.ts               # child_process.spawn + SSE-and-disk pipe (project subtree)
    │   ├── config.ts               # maister.yaml v1 loader: project + flows[], zod-validated, slug derivation
    │   ├── projects.ts             # Project registry CRUD, slug derivation, slug + repo_path uniqueness, recursive MAISTER_PROJECTS_DIR scan
    │   ├── scheduler.ts            # Global concurrency cap + Pending queue
    │   ├── reconcile.ts            # Startup: per-project runs vs git worktree list
    │   └── db/                     # ── PERSISTENCE LAYER ──
    │       ├── client.ts           # Drizzle client (PG or SQLite via dialect)
    │       ├── schema.ts           # Tables: projects, tasks, runs, workspaces, hitl_requests
    │       └── migrations/         # drizzle-kit output
    │
    ├── styles/
    │   └── globals.css             # @tailwindcss + @heroui/styles
    │
    ├── types/                      # Shared TS types (browser+server safe)
    └── public/
```

## Dependency Rules

**Strict direction — outer depends on inner, never the reverse:**

```
app/<route>/page.tsx     ─┐
                          ├──► lib/* (server-only modules)  ──► lib/db/* (persistence)
app/api/*/route.ts       ─┘                                 ──► .maister/<project-slug>/runs/<run-id>/* (FS)
                                                            ──► child_process.spawn
app/<route>/actions.ts   ──► lib/* (via server-only import)
components/*             ──► (browser-safe utilities only)
```

- ✅ Route Handler (`app/api/.../route.ts`) imports from `lib/*`.
- ✅ Server Action (`app/.../actions.ts`) imports from `lib/*`.
- ✅ `lib/runner.ts` imports `lib/errors.ts`, `lib/atomic.ts`,
  `lib/worktree.ts`, `lib/projects.ts`, `lib/scheduler.ts`.
- ✅ `lib/projects.ts` imports `lib/config.ts` (to parse `maister.yaml`),
  `lib/db/*` (registry persistence), `lib/errors.ts`.
- ✅ `lib/scheduler.ts` imports `lib/db/*` (to count `Running` rows) and
  `lib/errors.ts`.
- ✅ `lib/db/schema.ts` and `lib/db/client.ts` are server-only and may use
  `node:*` modules.
- ❌ A Client Component (file with `"use client"`) imports anything from
  `lib/*` — `lib/` is server-only.
- ❌ `components/*` imports anything from `lib/*` or uses `node:*` APIs.
- ❌ `lib/errors.ts` imports from any other `lib/*` module (errors are
  innermost — pure types).
- ❌ Any `lib/*` module imports from `app/*` (the controller direction is
  one-way).
- ❌ `app/api/*/route.ts` calls another `app/api/*/route.ts` directly. If
  two routes share logic, extract it into `lib/`.
- ❌ `lib/worktree.ts` / `lib/runner.ts` constructs FS paths from raw user
  input. Project slugs come from `lib/projects.ts` (validated, kebab-case).

**Server-only enforcement:** prefer `"server-only"` import (Next.js
runtime guard) at the top of any `lib/` module that must never reach the
client bundle.

## Layer / Module Communication

- **UI → Server work:** prefer **Server Actions** (`app/.../actions.ts`)
  for mutations triggered from forms. Use **Route Handlers** (`app/api/`)
  when you need a stable HTTP surface (SSE stream, cron, HITL response
  endpoint).
- **Live updates:** SSE only via `app/api/runs/[id]/stream/route.ts`. Read
  side tails `.maister/<project-slug>/runs/<run-id>/<block-id>.log`. No client-side polling,
  no WebSockets.
- **State transitions:** driven by **subprocess exit code + presence of
  `needs-input.json`**. Never by `fs.watch`, `chokidar`, or polling. The
  state machine is owned by `lib/runner.ts` and reflected in the `runs`
  table via Drizzle.
- **HITL handoff:** Flow writes
  `.maister/<project-slug>/runs/<run-id>/needs-input.json` on graceful exit →
  UI renders form from `response_schema` (zod-validated) → server action
  writes `input-<block-id>.json` via `atomicWriteJson` (same subtree) → Flow
  re-invoked with `--resume <block-id>`. No live process across the wait.
- **Cross-`lib` calls:** allowed but unidirectional. Suggested layering
  inside `lib/` (lowest first): `errors` → `atomic` → `config` → `db` →
  `projects` → `worktree` → `scheduler` → `runner` → `reconcile`. A lower
  module never imports a higher one.
- **Error surfacing:** all known domain failures bubble up as
  `MaisterError` instances with a discriminated `code`. UI branches on
  `code`, never on string matching.

## Key Principles

1. **Resist premature abstraction.** Single executor (Claude Code),
   hard-coded. No adapter interface. No Flow designer. No multi-executor
   pool. Refactor only when a real second executor appears.
2. **Subprocess exit codes are the source of truth.** State transitions
   driven by process exit + artifact presence, not by file watchers or
   polling. One block = one subprocess that runs to natural completion.
3. **Atomic writes to `.maister/`.** Every JSON the Flow may read is
   written via `atomicWriteJson` (tmp + rename). Never partial-write.
4. **Server-only modules stay in `lib/`.** Anything that touches `node:*`,
   `child_process`, `fs`, or secrets must live under `lib/` and never be
   imported by a Client Component.
5. **Surgical changes.** Every changed line traces to the user's request.
   Do not refactor adjacent code while you're there.
6. **Typed errors only.** `MaisterError` with discriminated `code` for
   known domain failures. Never plain `Error` for domain errors.
7. **Migration path is intentional.** Today's `lib/` modules map cleanly
   to tomorrow's Domain (errors, types), Application (runner, reconcile),
   and Infrastructure (db, worktree, atomic, config) layers if Explicit
   Architecture becomes warranted.

## Code Examples

### Route Handler → lib/ (allowed direction)

```typescript
// app/api/runs/route.ts
import { spawnRun } from '@/lib/runner';
import { MaisterError } from '@/lib/errors';
import { db } from '@/lib/db/client';
import { runs } from '@/lib/db/schema';

export async function POST(req: Request) {
  const { taskId, workspacePath } = await req.json();

  try {
    const run = await spawnRun({ taskId, workspacePath });
    return Response.json(run, { status: 201 });
  } catch (err) {
    if (err instanceof MaisterError) {
      return Response.json(
        { code: err.code, message: err.message },
        { status: err.code === 'PRECONDITION' ? 409 : 500 },
      );
    }
    throw err;
  }
}
```

### Typed Error (Domain-level invariant)

```typescript
// lib/errors.ts
export type MaisterErrorCode =
  | 'PRECONDITION'
  | 'SPAWN'
  | 'NEEDS_INPUT'
  | 'HITL_TIMEOUT'
  | 'CRASH'
  | 'CONFLICT'
  | 'CONFIG';

export class MaisterError extends Error {
  readonly code: MaisterErrorCode;

  constructor(code: MaisterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MaisterError';
    this.code = code;
  }
}
```

### Atomic write (always tmp + rename)

```typescript
// lib/atomic.ts
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8' });
  await rename(tmpPath, path);
}
```

### Subprocess → SSE + disk (parallel pipe)

```typescript
// lib/runner.ts (excerpt)
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { MaisterError } from '@/lib/errors';
import { ensureWorktree } from '@/lib/worktree';

export function runBlock(opts: {
  projectSlug: string;
  runId: string;
  blockId: string;
  cmd: string;
  args: string[];
  cwd: string;
  onLine: (line: string, monotonicId: number) => void;
}): Promise<{ exitCode: number; hasNeedsInput: boolean }> {
  return new Promise((resolve, reject) => {
    const logPath = join(
      '.maister',
      opts.projectSlug,
      'runs',
      opts.runId,
      `${opts.blockId}.log`,
    );
    const fileStream = createWriteStream(logPath, { flags: 'a' });
    let buffer = '';
    let monotonicId = 0;

    const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd });

    child.stdout.on('data', (chunk: Buffer) => {
      fileStream.write(chunk);
      buffer += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        opts.onLine(line, ++monotonicId);
      }
    });

    child.on('error', (err) =>
      reject(new MaisterError('SPAWN', `spawn failed: ${err.message}`, { cause: err })),
    );

    child.on('exit', async (code) => {
      fileStream.end();
      const hasNeedsInput = await needsInputExists(opts.runId);
      resolve({ exitCode: code ?? -1, hasNeedsInput });
    });
  });
}
```

### Forbidden: Client Component importing `lib/`

```typescript
// ❌ BAD — components/run-status.tsx
'use client';
import { db } from '@/lib/db/client';   // ← LEAKS server-only code into browser bundle

export function RunStatus({ runId }: { runId: string }) {
  const row = db.select().from(runs).where(eq(runs.id, runId));   // ← runs in browser
  return <span>{row[0].status}</span>;
}

// ✅ GOOD — fetch via Route Handler from the client
'use client';
import { useEffect, useState } from 'react';

export function RunStatus({ runId }: { runId: string }) {
  const [status, setStatus] = useState<string>('Loading');
  useEffect(() => {
    fetch(`/api/runs/${runId}`).then((r) => r.json()).then((d) => setStatus(d.status));
  }, [runId]);
  return <span>{status}</span>;
}
```

### Forbidden: Route Handler bypassing `lib/`

```typescript
// ❌ BAD — app/api/runs/[id]/merge/route.ts
import { execSync } from 'node:child_process';

export async function POST(_req: Request, ctx: { params: { id: string } }) {
  execSync(`git merge --no-ff feature/${ctx.params.id}`);  // ← logic in controller
  return Response.json({ ok: true });
}

// ✅ GOOD — orchestrate via lib/worktree.ts
import { mergeWorktree } from '@/lib/worktree';
import { MaisterError } from '@/lib/errors';

export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    await mergeWorktree(ctx.params.id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof MaisterError && err.code === 'CONFLICT') {
      return Response.json({ code: 'CONFLICT' }, { status: 409 });
    }
    throw err;
  }
}
```

## Anti-Patterns

- ❌ **`fs.watch` / `chokidar` / polling for state transitions.** Subprocess
  exit codes drive transitions. Adding a watcher introduces races and
  zombie processes.
- ❌ **Long-running subprocess across a HITL wait.** A block runs to natural
  exit. Re-invoke with `--resume <block-id>` after input.
- ❌ **String-matched errors.** `if (err.message.includes('conflict'))` is
  forbidden. Use `MaisterError.code`.
- ❌ **Partial-writing artifacts.** Direct `writeFile` into
  `.maister/<project-slug>/runs/<run-id>/` instead of `atomicWriteJson` will
  be read mid-write by the Flow.
- ❌ **`lib/` import from a Client Component.** Server-only modules leak
  into the browser bundle. Use Route Handlers or Server Actions as the
  boundary.
- ❌ **Layer skipping.** Route Handler running raw `execSync` instead of
  going through `lib/worktree.ts` or `lib/runner.ts`. Keep `app/api/` thin.
- ❌ **Premature adapter interfaces.** No `ExecutorAdapter`, no
  `FlowAdapter`. Claude Code is hard-coded until a real second executor
  appears.
- ❌ **Anemic `MaisterError`.** Constructing `new Error('something failed')`
  for a known domain failure. If the error has a meaningful UI branch,
  it belongs in the `code` taxonomy.
- ❌ **Streaming or logging secrets.** API keys must never appear in SSE
  output, subprocess argv visible to the frontend, or committed code.
- ❌ **Refactoring out-of-POC scope.** Multi-executor pool, AI-Judge, Flow
  designer, background agents, Telegram, A/B runs — all explicitly out.
  Push back with "out of POC scope".
