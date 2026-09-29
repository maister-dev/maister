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
- **Librarian entry (Designed — ADR-191):** opens the personal
  [librarian panel](librarian-panel.md) in place (no navigation) and receives
  restored focus when the panel closes. It binds no keyboard shortcut —
  Cmd/Ctrl+K stays the scratch launcher.

## Layout & regions

Left: logo + a **Desk | Projects** switch + a breadcrumb (`~/projects` and the
active crumb). The switch (Implemented — `web/components/chrome/home-switch.tsx`)
is the explicit control for the two meanings `/` used to carry: **Desk** targets
`/`, **Projects** targets `/projects` (ADR-172 D3). The logo itself means "home"
and keeps targeting `/`. The switch is hidden below `md`, where the mobile rail
drawer already reaches every destination; the breadcrumb is hidden below `lg`,
where the rail (present from `md`) already marks the active section and the
header has no room for it.

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

**Librarian entry (Designed — ADR-191).** The right group gains the Librarian
entry, rendered for every authenticated user on every `(app)` route: icon and
label where the width allows, the icon alone below `md` with an explicit
`aria-label`, and — like the mobile rail trigger — never dropped. It carries at
most one indicator, `running`, `unread` or `action_required`, and never a
numeric count, so it cannot compete with the canonical `decisions` / `updates`
badges. When the librarian is disabled or has no ready runner the entry still
renders; the panel states the reason. The panel itself is
[`librarian-panel.md`](librarian-panel.md).

**Narrow (Implemented — `NAV-07`).** The header is laid out narrow-first: `gap-2
px-3` below `lg`, widening to `gap-8 px-6` above it, with `min-w-0` on both
groups and `shrink-0` on everything that must keep its size. Below `lg` the
language switch shows only the CURRENT locale (`EN`, not `EN · RU`), the theme
switch only its icon, and the user's name is capped at 48px; the language and
theme switches carry an explicit `aria-label`, so what shrinks is the
affordance and never the accessible name. The user's name truncates by CSS and
stays whole in the DOM — removing it would take the person's name out of the
control's accessible name — and the crumb truncates in the same way at the
widths where it is shown. The mobile rail trigger, the only route to navigation
below `md`, is never dropped. This replaced a header that overflowed a 390px
viewport on every route (`/work` 471px, `/inbox` 479px) and made the whole page
scroll sideways. Below `md` the logo's wordmark is `sr-only` (ADR-191
amendment): the mark stays visible and the wordmark stays the home link's
accessible name, which is the room the Librarian entry needs.

The wide layout starts at `lg`, not `md`: at 768px it needed more than the
viewport — RU overflowed to 773-776px on every route, EN to 777px — because the
right group shrank below its content and the user menu spilled past the edge.
The theme switch's pre-mount placeholder lays out the same box invisibly, with
the wider word ("Light"), so hydration can only narrow the header; a fixed
68px placeholder had been Dark's width, and Light grew the header 8px at
mount.

## States

Authenticated only (the `(app)` group redirects unauthenticated requests to
`/login`); the user menu is omitted when no session user is present.

## Data & APIs

No data fetch of its own. The breadcrumb is static; the user identity comes from
the session resolved in the layout.

(Designed — ADR-191) The Librarian entry's indicator is read once by the
`(app)` layout (`readLibrarianIndicator`, which never creates a conversation —
`none` for a user who never opened it) and is kept fresh by the
`librarian.indicator` frames of `GET /api/librarian/stream`
([`../../api/async/librarian-stream.asyncapi.yaml`](../../api/async/librarian-stream.asyncapi.yaml)):
`unread` from the conversation's `read_through_seq`, `action_required` from a
pending owner card, `running` from the active turn.

## i18n

`nav` namespace (`crumbProjects`, `switchDesk`, `switchProjects`, `switchLabel`,
`crumbDesk`, plus the section labels the crumb reuses); the user menu and
locale/theme switches own their strings. The Librarian entry's label and
indicator names live in the `librarian` namespace (Designed).

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
- Librarian entry (Designed): [`librarian-panel.md`](librarian-panel.md),
  [`../../system-analytics/librarian-surface.md`](../../system-analytics/librarian-surface.md),
  [ADR-191](../../decisions.md#adr-191-librarian-surface-top-navigation-entry-and-right-side-panel).
