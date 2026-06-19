# Frontend Rules

> Area-specific conventions for the Next.js / React / HeroUI surface.
> Loaded after `rules/base.md`. Authoritative source: `web/CLAUDE.md` —
> update both when they drift.

## Rules

- Default to React Server Components. Add `"use client"` only when the component uses state, effects, browser APIs, or HeroUI client components.
- Use HeroUI v3 (`@heroui/react`) for every UI primitive (`Button`, `Card`, `Modal`, `Input`, `Navbar`). Do not add shadcn/ui, MUI, Chakra, Radix, or hand-rolled equivalents.
- Prefer **icon buttons** (or icon + label) over text-only buttons for actions; icon-only controls MUST carry an `aria-label`/`title`. Use `@heroicons/react` (no hand-rolled SVGs for standard actions). Destructive actions (delete/remove) get a distinct icon + danger tone. Signal success with a green check glyph (red ✗ / amber warning for failure), not the word "Succeeded". Full rationale in `web/CLAUDE.md` → UI affordance conventions.
- Style with Tailwind 4 utility classes. For variant-based class composition use `tailwind-variants` (`tv(...)`) mirroring `web/components/primitives.ts`. Use `clsx` only for ad-hoc class merging.
- Default theme is `dark` (`<Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>` in `app/layout.tsx`). Toggle via `next-themes` `useTheme()`.
- React component files: `kebab-case.tsx`. Named exports preferred for new components.
- Import server-only modules (`@/lib/*`, `@/lib/db/*`) from Server Components, Server Actions, or Route Handlers only. Never from a file with `"use client"`.
- Use the `@/...` path alias for cross-directory imports rooted at `web/`. No deep relative paths (`../../..`).
- Route handlers go in `app/api/<segment>/route.ts` and export named `GET`/`POST`/etc. Keep handlers thin: validate input, call into `@/lib/*`, format response.
- For form mutations triggered from the UI, prefer Server Actions (`app/.../actions.ts`) over manual `fetch` to API routes. Use API routes for SSE (`/api/runs/[id]/stream`), cron, and the HITL response endpoint.
- SSE consumption: open one `EventSource` per run-detail page. Reconnect with `lastEventId`. Tear down on unmount.
- Render git-tracked file content and run diffs through the ADR-066 stack: server-rendered **Shiki** for read-only file views, **`@git-diff-view/react`** (split/inline, per-file `+`/`−`) for diffs, **CodeMirror 6** for authored-Flow editing. Plain `<pre>` is no longer the workbench default — reserve it for incidental non-highlighted text.
- Branch the UI on `MaisterError.code`, never on `err.message`. The error code is the contract.
- ESLint warnings count: do not commit code that adds new warnings. `no-console`, `react/jsx-sort-props`, `import/order`, `padding-line-between-statements`, `unused-imports/no-unused-imports`, and `react/self-closing-comp` are enforced auto-fixable rules.
- Do not ship `console.log` in committed code. Add a server-side logger boundary when needed; the frontend should surface errors via toasts/UI, not the console.
- API keys and tokens are server-only. Never read from `process.env` inside a Client Component or pass them as props from a Server Component to a Client Component.
