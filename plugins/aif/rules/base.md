# AIF Package Rules

- Use project-scoped authorization and project-local context.
- Do not execute setup hooks during authoring, import, export, or local catalog
  publication.
- Validate `flow.yaml` and package file paths before publish or export.
- Keep generated artifacts portable: relative paths only, no host-specific
  absolute paths.
