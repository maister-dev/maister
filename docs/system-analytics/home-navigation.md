# Home navigation

## Purpose

The application's **information architecture above the page level**: what `/`
renders, where the project portfolio lives, which rail section a route
highlights, and which surface a user lands on after sign-in. The domain exists
because `/` acquired two meanings — "home" and "the portfolio" — and those
meanings now diverge; its invariants are testable and had no owning document.
Locked by [ADR-171](../decisions.md#adr-171-desk-home-information-architecture-and-the-member-default-route).
It owns no data and no authorization: every rule here is about routing and
rendering, and nav visibility is explicitly **not** an access control
(see NAV-06).

## Domain entities

- **The Desk** — `/`. Composes the Now tiles, the decision queue, work in
  flight, the activity feed and the digest sentence. Composition only; it
  re-implements none of them.
- **The portfolio** — `/projects`. The project-card grid formerly at `/`,
  behaviour unchanged, including the onboarding checklist and empty state.
- **`RailSectionId`** — the rail's section vocabulary, gaining `home`, `work`
  and `activity`.
- **`railSectionForPathname`** — the pure route-prefix → section classifier.
- **`buildLeftRailSections`** — the role-aware section list; its admin-only tail
  is a convenience, never a boundary.
- **Landing route** — the post-sign-in destination, forked once by
  `role !== "admin"`.

## State machine

Navigation has no persisted state. The one branching decision is the landing
route, resolved once per sign-in.

```mermaid
stateDiagram-v2
    [*] --> SignedIn
    SignedIn --> Desk: role is admin
    SignedIn --> Work: role is member or viewer
    Desk --> Work: rail Work
    Desk --> Projects: rail Projects
    Work --> Desk: rail Home
    Projects --> Desk: rail Home
    Work --> Activity: rail Activity
    Activity --> Desk: rail Home
```

## Process flows

Route prefix to highlighted rail section. The classifier must be total over the
application's prefixes; `/` resolves to `home`, and the `/runs` and
`/scratch-runs` collapse onto `projects` is deliberate and retained.

```mermaid
flowchart TD
    A["pathname"] --> N["normalize: strip query, hash, trailing slash"]
    N --> R{"prefix"}
    R -- "/" --> H["home"]
    R -- "/work" --> W["work"]
    R -- "/activity" --> AC["activity"]
    R -- "/projects, /runs, /scratch-runs" --> P["projects"]
    R -- "/inbox" --> I["inbox"]
    R -- "/studio, /flows" --> S["studio"]
    R -- "/observatory" --> O["observatory"]
    R -- "admin prefixes" --> AD["agents, mcps, users, scheduler, settings"]
    R -- "unmatched" --> X["null, nothing highlighted"]
```

Intent classification for inbound links to `/`. Two call sites mean "the
portfolio" and must move; the rest mean "home" and must not.

```mermaid
flowchart LR
    L1["auth layout logo"] --> HOME["/"]
    L2["top-nav logo"] --> HOME
    L3["error fallback"] --> HOME
    L4["change-password page"] --> HOME
    L5["change-password action"] --> HOME
    L6["new-project-form push"] --> PROJ["/projects"]
    L7["rail Projects href"] --> PROJ
```

## Expectations

- **NAV-01:** `/` MUST render the Desk for an admin.
- **NAV-02:** A user whose `role !== "admin"` — `member` or `viewer` — MUST land on `/work` after sign-in.
- **NAV-03:** `/projects` MUST render the former portfolio unchanged, including its onboarding checklist and empty state.
- **NAV-04:** `railSectionForPathname` MUST be total over the application's route prefixes and MUST map `/` to `home`.
- **NAV-05:** Every inbound link to `/` MUST resolve to the surface its call site intends; a call site meaning "the portfolio" MUST target `/projects`.
- **NAV-06:** Rail visibility MUST NEVER be the authorization boundary — every route the rail hides MUST still be refused server-side on its own.

## Edge cases

- **EDGE-NAV-01:** No projects exist — the Desk renders the first-run onboarding checklist and empty-state card inside its own frame, and the scratch composer is absent until a project exists.
- **EDGE-NAV-02:** Narrow viewports stack the Desk regions in the order Decisions, then Work, then Activity; no region is dropped and none becomes horizontally scrollable at the page level.

## Linked artifacts

- [ADR-171 — Desk home IA and the member default route](../decisions.md#adr-171-desk-home-information-architecture-and-the-member-default-route)
- [M51 requirement traceability](m51-traceability.md)
- [Screen reference — the Desk](../screens/desk.md)
- [Screen reference — left rail](../screens/chrome/left-rail.md)
- [Screen reference — top nav](../screens/chrome/top-nav.md)
- [`web/components/chrome/left-rail-route.ts`](../../web/components/chrome/left-rail-route.ts)
- [`web/components/chrome/left-rail-sections.ts`](../../web/components/chrome/left-rail-sections.ts)
