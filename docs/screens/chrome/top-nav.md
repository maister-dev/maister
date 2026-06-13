# Top nav

- **Type:** chrome (persistent header, every `(app)` screen).
- **Status:** Implemented (WI-3 removed the duplicate supervisor dot).
- **Source:** `web/components/chrome/top-nav.tsx`.

## JTBD

When I move between screens, I want a stable header with the product mark, a
breadcrumb of where I am, and quick access to locale, theme, and my account — so
orientation and personal controls are always one click away.

## Roles & capabilities

No role gate — renders for every authenticated user. The user menu exposes
account actions (change password, sign out); admin destinations live in the
[left rail](left-rail.md), not here.

## Navigation

- **Logo** → `/` (portfolio).
- **Breadcrumb** → `~/projects` plus the per-screen crumb.
- **User menu** → change password, sign out.
- **Locale / theme** toggles act in place (cookie / class), no navigation.

## Layout & regions

Left: logo + a breadcrumb (`~/projects` and the active crumb). Right: language
switch, theme switch, and the user menu. After WI-3 the breadcrumb no longer
carries a supervisor status dot — supervisor status is shown once in the footer
([`status-bar.md`](status-bar.md)).

## States

Authenticated only (the `(app)` group redirects unauthenticated requests to
`/login`); the user menu is omitted when no session user is present.

## Data & APIs

No data fetch of its own. The breadcrumb is static; the user identity comes from
the session resolved in the layout.

## i18n

`nav` namespace (`crumbProjects`); the user menu and switches own their strings.

## Linked artifacts

- Behavior: [`../../system-analytics/identity-access.md`](../../system-analytics/identity-access.md)
  (sessions, account menu).
- Source: `web/components/chrome/top-nav.tsx`,
  `web/components/chrome/user-menu.tsx`,
  `web/components/chrome/platform-status.tsx` (`PlatformStatusDot`, still used by
  the login side panel).
