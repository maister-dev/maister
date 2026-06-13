# Status bar

- **Type:** chrome (persistent footer, every `(app)` screen).
- **Status:** Planned (this branch — WI-3 makes it the single supervisor-status
  source).
- **Source:** `web/components/chrome/status-bar.tsx`.

## JTBD

When I am anywhere in the app, I want a single always-visible indicator of
whether the supervisor is reachable — so I know at a glance whether launches and
live runs can proceed.

> Layout & regions, States, Data & APIs, i18n, and Linked artifacts are filled
> when WI-3 lands (supervisor status shown exactly once, here). See
> [`../README.md`](../README.md) for the template.
