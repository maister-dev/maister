# Architecture: Structured Modules (Technical Layers) + ACP Supervisor

## Overview

MAIster is split into **two Node processes** following Structured Modules
with technical-layer organization:

- **`web/`** — Next.js 16 monolith: UI + Route Handlers + server actions +
  Drizzle DB access + SSE bridge to supervisor. No agent processes.
- **`supervisor/`** — separate Node daemon: owns ACP sessions, spawns one
  agent process (`claude`, `codex`) per session, heartbeat watchdog,
  graceful checkpoint + respawn via `--resume`. HTTP+SSE IPC.

Inside `web/`, two organizational axes coexist:

1. **Feature-folder routes** under `app/` (App Router convention): each
   user-visible area — `(portfolio)` (home grid), `projects`,
   `projects/[slug]` (board + Inbox block), `runs`, settings — gets its
   own folder with pages, server actions, and Route Handlers.
2. **Technical-layer modules** under `lib/`: cross-cutting infrastructure
   (`errors`, `atomic`, `worktree`, `config`, `flows`, `executors`,
   `supervisor-client`, `projects`, `scheduler`, `db`, `reconcile`)
   organized by concern, not by feature.

Inside `supervisor/`, modules organized by concern: `acp-client`, `spawn`,
`heartbeat`, `checkpoint`, `http-api`.

This honors the post-ACP-revision structure without bolting on ceremony
the current target doesn't need. Migration to **Explicit Architecture** stays
trivial later: `lib/db/` becomes Infrastructure, the `MaisterError`
taxonomy becomes Domain, and use-case services move out of Route Handlers
into an Application layer; `supervisor/` already IS its own bounded
context.

## Decision Rationale

- **Project type:** Web control plane (Next.js + separate supervisor
  daemon, two Node processes; single host current target, supervisor can later move
  to a different host without code change).
- **Tech stack:** Next.js 16 App Router · TypeScript 5.6 (strict) · HeroUI
  v3 · Tailwind 4 · Drizzle ORM · Postgres 16 · ACP (Zed-standard) via
  separate `supervisor/` daemon · Node `child_process.spawn` for agent
  processes · CCR for model routing · pnpm.
- **Team size:** 1 (solo dev).
- **Domain complexity:** Medium-High — multi-project registry, Flow
  plugin engine, multi-executor (claude + codex), workspace lifecycle,
  ACP session keep-alive + checkpoint+resume state machine, hybrid HITL
  (ACP + artifact), supervisor↔web IPC, global concurrency scheduler.
- **Scale:** current target, single host (multi-host capable),
  `MAISTER_MAX_CONCURRENT_RUNS=3` (global cap).
- **Key factors:**
  - ACP is the executor interface — Stage 2 multi-executor pool is
    inherent, not bolted on later.
  - Crash isolation: agent processes belong in `supervisor/`, not
    Next.js, so HMR / dev-mode hot-reload doesn't kill live runs.
  - Next.js App Router already enforces feature-folder layout for routes,
    so adding bounded contexts on top inside `web/` would duplicate
    structure.
  - Cross-cutting concerns (errors, atomic writes, supervisor-client,
    git worktree, Flow plugin loader) are technical, not domain —
    natural fit for `lib/` modules organized by concern.

Why not single-process monolith? Agent processes need to outlive Next.js
HMR cycles in dev and Next.js restarts in prod; supervisor isolation
removes the failure mode where editing a UI file kills 3 running agents.

Why not Layered? The project has 7+ entities (`projects`, `tasks`,
`runs`, `workspaces`, `hitl_requests`, `flows`, `executors`) with
non-trivial invariants (multi-project registry, Flow plugin install
lifecycle, ACP session state machine, worktree lifecycle, global
concurrency scheduler, per-step executor override resolution). A flat
`src/services/`, `src/controllers/` layout would mix unrelated logic.

Why not Explicit Architecture? Decision matrix puts it at team size 5-30
and "high" domain complexity. Domain logic today is small enough that
Domain/Application/Infrastructure separation would add ceremony without
payoff. Refactor path stays open.

Why not Microservices beyond web/supervisor split? The two-process split
is the minimum that gives crash isolation. Further fragmentation needs a
separate operating-model decision.

## Folder Structure

```
mAIster/
├── .ai-factory/                    # AI Factory context (this doc lives here)
├── ~/.maister/flows/<id>@<tag>/    # Host-side Flow plugin install cache (system-wide)
├── .maister/                       # Runtime artifacts (NOT committed)
│   └── <project-slug>/             # One subtree per registered project
│       ├── flows/<id>/             # Symlink to ~/.maister/flows/<id>@<tag>/
│       └── runs/<run-id>/
│           ├── <step-id>.log       # SSE pipe-to-disk (per step)
│           ├── needs-input.json    # HITL signal (structured form)
│           ├── input-<step-id>.json # HITL response (atomic write)
│           ├── session.json        # { acp_session_id, executor_id }
│           └── cost.jsonl          # token-count metrics, append-only
├── docs/                           # Product + engineering docs
│
├── supervisor/                     # ── ACP SUPERVISOR DAEMON ──
│   ├── package.json                # Separate npm package
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts                 # HTTP+SSE API entry: POST /sessions, etc.
│       ├── acp-client.ts           # Zed-standard ACP client (one per session)
│       ├── spawn.ts                # child_process.spawn per session (claude/codex)
│       ├── heartbeat.ts            # crash detection → mark Crashed
│       ├── checkpoint.ts           # graceful pause on idle timeout
│       └── http-api.ts             # Route handlers (Express/Fastify)
│
└── web/                            # ── NEXT.JS WEB TIER ──
    ├── app/                        # ── ROUTES & PRESENTATION (feature folders) ──
    │   ├── layout.tsx              # Root layout (Providers + Navbar w/ project switcher)
    │   ├── page.tsx                # Portfolio home (superset.sh-style grid + "Needs you (N)" badge)
    │   ├── projects/
    │   │   ├── page.tsx            # Projects list + "Add project" button
    │   │   ├── new/page.tsx        # Add-project form (paste maister.yaml dir, installs Flow plugins)
    │   │   └── [slug]/
    │   │       ├── page.tsx        # Per-project board (Backlog | In Flight) + Inbox block
    │   │       ├── actions.ts      # Server actions: create-task, launch, discard-task, hitl-respond
    │   │       ├── components/     # Board-local components (columns, cards, Launch, HITL form)
    │   │       └── tasks/
    │   │           └── new/page.tsx # Task creation: title + prompt + Flow dropdown + executor override
    │   ├── runs/
    │   │   └── [id]/
    │   │       ├── page.tsx        # Run detail: status + logs + HITL + diff + activity-ping
    │   │       ├── actions.ts      # Server actions: mark-ready, merge, abandon, recover
    │   │       └── components/     # Run-detail-local components
    │   └── api/                    # ── ROUTE HANDLERS (controllers) ──
    │       ├── projects/
    │       │   ├── route.ts                  # POST /api/projects (register + install flows)
    │       │   └── [slug]/
    │       │       ├── route.ts              # DELETE (soft-archive)
    │       │       └── tasks/route.ts        # POST tasks (per-project)
    │       ├── runs/
    │       │   ├── route.ts                  # POST /api/runs (preconditions + supervisor session)
    │       │   └── [id]/
    │       │       ├── stream/route.ts       # GET SSE (bridges supervisor SSE)
    │       │       ├── hitl/[hitlRequestId]/respond/route.ts # POST HITL response
    │       │       ├── activity/route.ts     # POST keepalive bump
    │       │       ├── diff/route.ts         # GET git diff
    │       │       ├── merge/route.ts        # POST git merge --no-ff
    │       │       ├── abandon/route.ts      # POST abandon
    │       │       └── recover/route.ts      # POST recover (Crashed → --resume)
    │       └── cron/
    │           └── gc/route.ts               # GET worktree + session GC (all projects)
    │
    ├── components/                 # ── SHARED PRESENTATION COMPONENTS ──
    │   ├── navbar.tsx              # HeroUI Navbar + project switcher + Needs-you badge
    │   ├── theme-switch.tsx        # next-themes toggle
    │   ├── icons.tsx               # Inline SVG icons
    │   ├── primitives.ts           # tailwind-variants title()/subtitle()
    │   ├── portfolio-card.tsx      # Workspace card on portfolio home
    │   ├── board-column.tsx        # Board column (Backlog / In Flight)
    │   ├── task-card.tsx           # Task card on board (carries Launch button when in Backlog)
    │   ├── hitl-form.tsx           # Inline form rendered from JSON Schema
    │   └── inbox-block.tsx         # HITL Inbox panel on board page
    │
    ├── config/                     # ── SITE-LEVEL CONFIG (static) ──
    │   ├── site.ts                 # navItems (Portfolio/Projects/Settings)
    │   └── fonts.ts                # Inter + Fira Code via next/font
    │
    ├── lib/                        # ── TECHNICAL-LAYER MODULES (server-only) ──
    │   ├── errors.ts               # MaisterError discriminated union (expanded taxonomy)
    │   ├── atomic.ts               # atomicWriteJson (tmp + rename)
    │   ├── worktree.ts             # git worktree add/remove/list wrapper (project-scoped paths)
    │   ├── supervisor-client.ts    # HTTP+SSE client to ../supervisor/
    │   ├── config.ts               # maister.yaml v2 loader + flow.yaml manifest parser, zod-validated
    │   ├── flows.ts                # Flow plugin install: git clone --branch <tag>, symlink, manifest validation
    │   ├── executors.ts            # Executor registry + override-resolution + CCR env construction
    │   ├── projects.ts             # Project registry CRUD, recursive MAISTER_PROJECTS_DIR scan, Flow install on register
    │   ├── scheduler.ts            # Global concurrency cap + Pending queue
    │   ├── reconcile.ts            # Startup: runs vs git worktree list vs supervisor sessions
    │   └── db/                     # ── PERSISTENCE LAYER ──
    │       ├── client.ts           # Drizzle client (PG or SQLite via dialect)
    │       ├── schema.ts           # projects, tasks, runs, workspaces, hitl_requests, flows, executors
    │       └── migrations/         # drizzle-kit output
    │
    ├── i18n/                       # ── INTERNATIONALIZATION ──
    │   ├── en/                     # English source-of-truth
    │   └── ru/                     # Russian translations (required from day one)
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
                                                            ──► lib/supervisor-client (HTTP+SSE to ../supervisor/)
app/<route>/actions.ts   ──► lib/* (via server-only import)
components/*             ──► (browser-safe utilities only)

# Cross-process boundary (HTTP+SSE)
web/lib/supervisor-client ──HTTP──► supervisor/src/http-api  ──► supervisor/src/spawn ──► child_process.spawn (claude/codex)
                          ◄──SSE── supervisor/src/acp-client (Zed-standard ACP)
```

- ✅ Route Handler (`app/api/.../route.ts`) imports from `lib/*`.
- ✅ Server Action (`app/.../actions.ts`) imports from `lib/*`.
- ✅ `lib/supervisor-client.ts` imports `lib/errors.ts` only (HTTP wire format).
- ✅ `lib/flows.ts` imports `lib/errors.ts`, `lib/atomic.ts`,
  `lib/config.ts`, `lib/db/*`.
- ✅ `lib/executors.ts` imports `lib/errors.ts`, `lib/db/*`.
- ✅ `lib/projects.ts` imports `lib/config.ts`, `lib/flows.ts`,
  `lib/executors.ts`, `lib/db/*`, `lib/errors.ts`.
- ✅ `lib/scheduler.ts` imports `lib/db/*` (to count `Running` rows) and
  `lib/errors.ts`.
- ✅ `lib/reconcile.ts` imports `lib/db/*`, `lib/worktree.ts`,
  `lib/supervisor-client.ts`, `lib/errors.ts`.
- ✅ `lib/db/schema.ts` and `lib/db/client.ts` are server-only and may use
  `node:*` modules.
- ❌ A Client Component (file with `"use client"`) imports anything from
  `lib/*` — `lib/` is server-only.
- ❌ `components/*` imports anything from `lib/*` or uses `node:*` APIs.
- ❌ `lib/errors.ts` imports from any other `lib/*` module (errors are
  innermost — pure types).
- ❌ Any `lib/*` module imports from `app/*` (the controller direction is
  one-way).
- ❌ Any `lib/*` module **directly spawns `claude` or `codex`** —
  agent processes are owned by `supervisor/`; web tier goes through
  `lib/supervisor-client.ts` only.
- ❌ Any `lib/*` module **imports from `supervisor/*`** — supervisor is
  a separate process; the only contract is the HTTP+SSE API.
- ❌ `app/api/*/route.ts` calls another `app/api/*/route.ts` directly. If
  two routes share logic, extract it into `lib/`.
- ❌ `lib/worktree.ts` constructs FS paths from raw user input. Project
  slugs come from `lib/projects.ts` (validated, kebab-case).

**Server-only enforcement:** prefer `"server-only"` import (Next.js
runtime guard) at the top of any `lib/` module that must never reach the
client bundle.

## Layer / Module Communication

- **UI → Server work:** prefer **Server Actions** (`app/.../actions.ts`)
  for mutations triggered from forms. Use **Route Handlers** (`app/api/`)
  when you need a stable HTTP surface (SSE stream, cron, HITL response
  endpoint, activity ping).
- **Web ↔ supervisor:** HTTP + SSE only. `lib/supervisor-client.ts` is the
  single boundary; no other `lib/*` module talks to supervisor directly.
  The supervisor URL is `MAISTER_SUPERVISOR_URL` (env), defaults to
  `http://localhost:7777`. Supervisor may run on a different host.
- **Live updates:** supervisor emits SSE per ACP `session/update`; Next.js
  Route Handler (`app/api/runs/[id]/stream/route.ts`) bridges to the
  browser, tailing `.maister/<project-slug>/runs/<run-id>/<step-id>.log`
  on reconnect via `lastEventId`. No client-side polling, no WebSockets.
- **State transitions:** driven by **ACP notifications** (live path) and
  **artifact presence** (durable path, e.g. `needs-input.json`). Never by
  `fs.watch`, `chokidar`, or polling on the web tier. The state machine
  is split: supervisor owns process-level state (live / checkpointed /
  crashed); web tier owns run-level state (`Running | NeedsInput |
  NeedsInputIdle | Review | Crashed | …`) reflected in the `runs` table.
- **HITL handoff:** adapter emits ACP `requestPermission` or the runner
  reaches a form/human step -> web tier records `hitl_requests` row ->
  UI renders an option picker or schema form -> response route performs
  a DB claim before resolving supervisor permission or writing
  `input-<step-id>.json` via `atomicWriteJson`. The runner owns
  `NeedsInput -> Running`.
- **Cross-`lib` calls:** allowed but unidirectional. Suggested layering
  inside `web/lib/` (lowest first): `errors` → `atomic` → `config` →
  `db` → `executors` → `flows` → `projects` → `worktree` →
  `supervisor-client` → `scheduler` → `reconcile`. A lower module never
  imports a higher one.
- **Error surfacing:** all known domain failures bubble up as
  `MaisterError` instances with a discriminated `code`. UI branches on
  `code`, never on string matching.

## Key Principles

1. **ACP is the executor interface.** No bespoke adapter interface.
   claude + codex today. New executors land by adding to the
   `executors[]` registry — no code change in the call sites.
2. **Agent processes live in `supervisor/`, not Next.js.** Crash
   isolation matters: HMR / dev-mode hot reload must not kill live
   agents.
3. **ACP notifications + artifact presence are the source of truth.**
   State transitions driven by ACP events on the live path and artifact
   presence on the recovery path. Never `fs.watch`, `chokidar`, or
   polling. The web tier reflects state in the `runs` table; supervisor
   owns process-level state.
4. **Atomic writes to `.maister/`.** Every JSON the Flow / agent may
   read is written via `atomicWriteJson` (tmp + rename). Never
   partial-write.
5. **Server-only modules stay in `lib/`.** Anything that touches
   `node:*`, `child_process`, `fs`, or secrets must live under `lib/`
   and never be imported by a Client Component.
6. **Surgical changes.** Every changed line traces to the user's request.
   Do not refactor adjacent code while you're there.
7. **Typed errors only.** `MaisterError` with discriminated `code` for
   known domain failures (expanded taxonomy: `EXECUTOR_UNAVAILABLE`,
   `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`). Never plain `Error`
   for domain errors.
8. **Scope labels guide planning, not blocking.** Treat `Implemented`,
   `Designed`, and `Phase 2` as current status labels. Useful work can
   move between labels when the implementation plan updates the contracts.
9. **Migration path is intentional.** Today's `web/lib/` modules map
   cleanly to tomorrow's Domain (errors, types), Application
   (supervisor-client, reconcile, scheduler), and Infrastructure (db,
   worktree, atomic, config, flows, executors) layers if Explicit
   Architecture becomes warranted. The web/supervisor split is the
   first bounded-context boundary; further fragmentation is Phase 2+.

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

### Web tier → supervisor (HTTP+SSE boundary)

```typescript
// web/lib/supervisor-client.ts (excerpt)
import { MaisterError } from '@/lib/errors';

const BASE = process.env.MAISTER_SUPERVISOR_URL ?? 'http://localhost:7777';

export async function createSession(opts: {
  runId: string;
  projectSlug: string;
  worktreePath: string;
  executor: { agent: 'claude' | 'codex'; model: string; env?: Record<string, string>; router?: 'ccr' };
  flowManifest: unknown;
  prompt: string;
}): Promise<{ acpSessionId: string }> {
  const res = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));

    throw new MaisterError(
      body?.code ?? 'SPAWN',
      body?.message ?? `supervisor POST /sessions ${res.status}`,
    );
  }

  return res.json();
}

export async function deliverInput(runId: string, stepId: string, value: unknown): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${runId}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stepId, value }),
  });

  if (!res.ok) {
    throw new MaisterError('ACP_PROTOCOL', `deliverInput ${res.status}`);
  }
}
```

### Supervisor → ACP session + disk pipe (separate process)

```typescript
// supervisor/src/spawn.ts (excerpt)
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

export function spawnAgent(opts: {
  agent: 'claude' | 'codex';
  resumeSessionId?: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onAcpEvent: (line: string, monotonicId: number) => void;
}): { kill: () => void } {
  const logPath = join('.maister', opts.projectSlug, 'runs', opts.runId, `${opts.stepId}.log`);
  const fileStream = createWriteStream(logPath, { flags: 'a' });

  const args = ['--acp'];                          // pseudocode; exact adapter CLI verified by local spike

  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  const child = spawn(opts.agent, args, { cwd: opts.cwd, env: opts.env });

  let buffer = '';
  let monotonicId = 0;

  child.stdout.on('data', (chunk: Buffer) => {
    fileStream.write(chunk);
    buffer += chunk.toString('utf8');
    let nl;

    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);

      buffer = buffer.slice(nl + 1);
      opts.onAcpEvent(line, ++monotonicId);
    }
  });

  child.on('exit', () => fileStream.end());

  return { kill: () => child.kill() };
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

- ❌ **`fs.watch` / `chokidar` / polling for state transitions.** ACP
  notifications on the live path + artifact presence on the recovery
  path drive transitions. Adding a watcher introduces races.
- ❌ **Spawning `claude` / `codex` from `web/lib/*`.** Agent processes
  are owned by `supervisor/`. Web tier goes through
  `lib/supervisor-client.ts` only.
- ❌ **Importing from `supervisor/*` inside `web/*`.** Supervisor is a
  separate process. The only contract is the HTTP+SSE API.
- ❌ **String-matched errors.** `if (err.message.includes('conflict'))` is
  forbidden. Use `MaisterError.code`.
- ❌ **Partial-writing artifacts.** Direct `writeFile` into
  `.maister/<project-slug>/runs/<run-id>/` instead of `atomicWriteJson` will
  be read mid-write by the agent.
- ❌ **`lib/` import from a Client Component.** Server-only modules leak
  into the browser bundle. Use Route Handlers or Server Actions as the
  boundary.
- ❌ **Layer skipping.** Route Handler running raw `execSync` instead of
  going through `lib/worktree.ts` or `lib/supervisor-client.ts`. Keep
  `app/api/` thin.
- ❌ **Bespoke executor adapter interfaces.** No `ExecutorAdapter`, no
  `FlowAdapter` beyond what `lib/executors.ts` and ACP provide. Adding
  Cursor / opencode / Aider is configuration, not a new interface.
- ❌ **Custom ACP extensions without an ADR.** Current target uses standard ACP
  only. Structured-form HITL goes via artifact, not custom notification.
- ❌ **Enforcing cost/time/regex guards without contract updates.** Parse-and-persist as
  metrics on disk only today. Enforcement is Phase 2.
- ❌ **Trusting Flow plugins from arbitrary sources.** Current target trusts internal
  sources only. Sandboxing + trust UI is Phase 2.
- ❌ **Anemic `MaisterError`.** Constructing `new Error('something failed')`
  for a known domain failure. If the error has a meaningful UI branch,
  it belongs in the `code` taxonomy.
- ❌ **Streaming or logging secrets.** API keys must never appear in SSE
  output, ACP `session/update` payloads visible to the browser, agent
  argv visible to the frontend, or committed code.
- ❌ **Implementing large scope without updating contracts.** Flow
  designer, background agents, Telegram, A/B runs, AI-Judge, extra
  executors, guard enforcement, and trust UI need explicit contract and
  roadmap updates before implementation.
