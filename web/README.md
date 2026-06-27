# MAIster Web

Next.js 16 + React 19 + HeroUI v3 control plane. Talks to `../supervisor/`
over HTTP+SSE. See `CLAUDE.md` (this directory) for stack, conventions, and
route map; `../CLAUDE.md` for product spine and architectural decisions.

## Run locally

From the repo root, with `pnpm` and Node 24 installed.

1. **Install deps** (workspace-wide):

   ```bash
   pnpm install --frozen-lockfile
   ```

2. **Configure env**. Copy the sample and fill the required keys:

   ```bash
   cp web/.env.sample web/.env.local
   ```

   At minimum set in `web/.env.local`:

   - `AUTH_SECRET` — generate with `openssl rand -base64 33` (or `npx auth secret`).
   - `DB_URL` — defaults to the compose Postgres at
     `postgres://maister:maister@localhost:5432/maister`. For SQLite use
     `file:./dev.db`.

   The file is gitignored. Never commit it.

3. **Start Postgres** (if using compose):

   ```bash
   docker compose up -d postgres
   ```

4. **Migrate and seed**:

   ```bash
   pnpm --filter maister-web db:migrate
   pnpm --filter maister-web db:seed
   ```

   Migrations are not applied automatically on `pnpm dev` — re-run
   `db:migrate` after pulling new migrations. See `lib/db/README.md`
   for schema details.

   Seed creates the admin user from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
   (default `admin@maister.local` / `maister-admin`, `must_change_password=true`).

5. **Start the supervisor** (separate process; required for run launches):

   ```bash
   pnpm --filter @maister/supervisor dev
   ```

6. **Start the web dev server**:

   ```bash
   pnpm --filter maister-web dev
   ```

   App: <http://localhost:3000> · supervisor: <http://localhost:7777>.

## Scripts

```bash
pnpm dev                # next dev
pnpm dev:clean          # remove .next, then next dev
pnpm clean              # remove .next
pnpm build              # remove .next, then next build
pnpm start              # next start (after build)
pnpm lint               # eslint --fix
pnpm typecheck          # tsc --noEmit
pnpm test               # unit + integration (vitest)
pnpm test:e2e           # playwright
pnpm db:generate        # drizzle-kit generate
pnpm db:migrate         # apply migrations
pnpm db:seed            # seed admin user
pnpm db:studio          # drizzle-kit studio
```

## License

MIT — see `../LICENSE`.
