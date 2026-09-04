# Public documentation rules

The files under `site-docs/` are the public product documentation. They are not
generated from, mirrored from, or interchangeable with the engineering notes
under `/docs`.

## Audience

Write for MAIster users, instance operators, integrators, and AI agents helping
those people. Do not publish internal milestones, implementation statuses, ADR
discussion, database internals, or repository-maintainer procedures unless they
are part of a supported public contract.

## Authoring

- Store every page as Markdown with `title` and `description` frontmatter.
- Keep headings descriptive and unique.
- Put one task or concept on one page.
- State prerequisites, exact inputs, success criteria, and failure signals.
- Prefer stable product terms: project, Flow package, task, Run, workspace,
  evidence, human-in-the-loop request, review, and promotion.
- English and Russian pages are separate authored translations. Update both when
  a public contract changes.
- Never put secrets in examples. Refer to environment variables by name.
- Link to the public documentation, not to internal `/docs` files.

## Verification

Run `pnpm validate` and `pnpm links` in this package before publishing. A future
cross-artifact check may compare supported public claims with `/docs`, but that
check must not turn either artifact into the source of the other.
