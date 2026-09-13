# Top nav

- **Type:** chrome (persistent header, every `(app)` screen).
- **Status:** Implemented (WI-3 removed the duplicate supervisor dot); mobile
  rail trigger is implemented in the UI completion batch.
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

- **Logo** → `/` (the Desk — "home"; ADR-172 D3).
- **Breadcrumb** → `~/projects` plus the per-screen crumb.
- **User menu** → change password, sign out.
- **Locale / theme** toggles act in place (cookie / class), no navigation.
- **Mobile rail trigger (Implemented):** below `md`, an icon button opens the
  one on-demand mobile left-rail drawer; it has an accessible name and receives
  restored focus when that drawer closes.

## Layout & regions

Left: logo + a **Desk | Projects** switch + a breadcrumb (`~/projects` and the
active crumb). The switch (Implemented — `web/components/chrome/home-switch.tsx`)
is the explicit control for the two meanings `/` used to carry: **Desk** targets
`/`, **Projects** targets `/projects` (ADR-172 D3). The logo itself means "home"
and keeps targeting `/`. Both the switch and the breadcrumb are hidden below
`md`, where the mobile rail drawer already reaches every destination and the
header has no room for them.

The switch marks its active option from `railSectionForPathname`, the same
classifier the rail highlights from — a second "am I on the portfolio" check is
how the header and the rail start disagreeing. The crumb
(`web/components/chrome/nav-crumb.tsx`) reads it too; it named "portfolio"
unconditionally before, which was false on the Desk.
Below `md`, the logo group also contains the mobile rail trigger. Right: language
switch, theme switch, and the user menu. The theme switch uses packaged
Heroicons: a sun for light mode and a moon for dark mode. After WI-3 the
breadcrumb no longer carries a supervisor status dot — supervisor status is
shown once in the footer ([`status-bar.md`](status-bar.md)).

**Narrow (Implemented — `NAV-07`).** The header is laid out narrow-first: `gap-2
px-3` below `md`, widening to `gap-8 px-6` above it, with `min-w-0` on both
groups and `shrink-0` on everything that must keep its size. Below `md` the
language switch shows only the CURRENT locale (`EN`, not `EN · RU`) and the
theme switch only its icon; both carry an explicit `aria-label`, so what
shrinks is the affordance and never the accessible name. The user's name
truncates by CSS and stays whole in the DOM — removing it would take the
person's name out of the control's accessible name — and the crumb truncates in
the same way at the widths where it is shown. The mobile rail trigger, the only
route to navigation below `md`, is never dropped. This replaced a header that
overflowed a 390px viewport on every route (`/work` 471px, `/inbox` 479px) and
made the whole page scroll sideways.

## States

Authenticated only (the `(app)` group redirects unauthenticated requests to
`/login`); the user menu is omitted when no session user is present.

## Data & APIs

No data fetch of its own. The breadcrumb is static; the user identity comes from
the session resolved in the layout.

## i18n

`nav` namespace (`crumbProjects`, `switchDesk`, `switchProjects`, `switchLabel`,
`crumbDesk`, plus the section labels the crumb reuses); the user menu and
locale/theme switches own their strings.

## Linked artifacts

- Behavior: [`../../system-analytics/identity-access.md`](../../system-analytics/identity-access.md)
  (sessions, account menu).
- Source: `web/components/chrome/top-nav.tsx`,
  `web/components/chrome/theme-switch.tsx`,
  `web/components/chrome/user-menu.tsx`,
  `web/components/chrome/platform-status.tsx` (`PlatformStatusDot`, still used by
  the login side panel), `web/components/chrome/home-switch.tsx`,
  `web/components/chrome/nav-crumb.tsx`.
- IA: [`../../system-analytics/home-navigation.md`](../../system-analytics/home-navigation.md)
  (`NAV-04`, `NAV-05`).
