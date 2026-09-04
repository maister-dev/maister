# MAIster public site

The public product landing page. It is intentionally separate from `web/`,
which remains the authenticated MAIster control plane.

```bash
cp site/.env.example site/.env.local
pnpm --filter @maister/site dev
```

The site runs at `http://localhost:3001`. `GITHUB_TOKEN` is required for the
repository widget while the GitHub repository is private; for a public
repository it only avoids the anonymous API limit. Set `NEXT_PUBLIC_DOCS_URL`
to override the public documentation origin. It defaults to
`https://docs.imaister.dev`; use `http://localhost:3002` while developing both
packages locally.

The hero imports `SpineGraph` directly from the authenticated web package so
the landing cannot drift into a second version of the login animation.

## Container image

Build from the repository root because the landing imports the shared login
animation from `web/`:

```bash
docker build --target production -f site/Dockerfile -t maister/site:local .
docker run --rm -p 127.0.0.1:3001:3001 -e GITHUB_TOKEN maister/site:local
```

`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_DOCS_URL` are build arguments because
Next.js embeds them into the production bundle. `GITHUB_TOKEN` stays a runtime
variable and is never written into the image.
