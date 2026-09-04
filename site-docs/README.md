# MAIster public documentation

This package is the source for the public documentation site. It is a separate
artifact from the repository's engineering documentation in `/docs`.

The planned public origin is `https://docs.imaister.dev`. Configure that custom
domain in the documentation host; the landing package uses the same value as
its default `NEXT_PUBLIC_DOCS_URL`.

- Write public pages directly as Markdown in this directory.
- Keep English and Russian navigation in parity.
- Describe supported user behavior, not implementation history.
- Use task-oriented pages with explicit prerequisites and observable results.
- Keep secrets out of examples; use `env:NAME` references.

Run `pnpm --filter @maister/site-docs dev` from the repository root. Mintlify
serves the site on `http://localhost:3002` and generates agent-readable
endpoints such as `/llms.txt`, `/llms-full.txt`, and `/mcp` when published.

## Container image

The production image validates links, exports the Markdown site with Mint, adds
raw Markdown plus `/llms.txt` and `/llms-full.txt`, and builds a Pagefind index
over the rendered page content. Search works without a Mint account or an
external search service. The result is served from a non-root static web server:

```bash
docker build --target production -f site-docs/Dockerfile -t maister/docs:local .
docker run --rm -p 127.0.0.1:3002:8080 maister/docs:local
```

Build and run both public artifacts together from the repository root:

```bash
docker compose -f compose.public.yml build
docker compose -f compose.public.yml up -d
```
