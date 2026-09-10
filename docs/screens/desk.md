# Desk

**Route:** `/` · **Status:** Designed (ADR-171) · **Source:** `web/app/(app)/page.tsx`

The home surface. Answers "what needs me, what moved, what is running" in one
screen, across every project the reader can see. It **composes** surfaces owned
elsewhere and re-implements none of them.

## JTBD

- When I sit down in the morning, I want one screen that tells me what is blocked
  on me, so I can start working instead of hunting across project boards.
- When I have been away, I want to see what changed while I was gone, so I can
  catch up without reading every run.
- When I want to start something ad hoc, I want to launch it from where I already
  am, so I do not have to pick a project first.

## Roles & capabilities

| Role | Sees | Does |
| --- | --- | --- |
| Global `admin` | Every non-archived project's decisions, work and activity | Every inline action the underlying surface allows |
| Global `member` | Only their own projects | Same actions, scoped to those projects |
| Global `viewer` | Only their own projects | Read-only; inline actions are absent, not merely disabled |

An admin lands here (`NAV-01`); `member` and `viewer` land on `/work` instead
(`NAV-02`). Scoping is `getVisibleProjectIds`, and every action is authorized
server-side on its own route — the Desk hides nothing it does not also refuse
(`NAV-06`).

## Navigation

Entry: the rail's **Home** section, both logo links, the error fallback, and the
post-sign-in landing route for an admin. Exits: each region links to its full
surface.

```mermaid
flowchart LR
    D["Desk /"] --> W["Work /work"]
    D --> A["Activity /activity"]
    D --> I["Inbox /inbox"]
    D --> P["Projects /projects"]
    D --> R["a run detail"]
    D --> T["a task detail"]
```

## Layout & regions

Top to bottom, in mockup order:

1. **Header + digest sentence** — the deterministic digest for the window since
   the reader's cursor (or a bounded 24 h fallback): promoted, crashed, new
   decisions, new events, tokens spent. One sentence, no narration, no cost in
   USD.
2. **Composer** — the existing scratch launcher. Idea-mode intake is a later
   milestone and is **not stubbed here**.
3. **Now tiles** — the same five counts as the digest, each a link target.
4. **Decisions** — the decision queue with inline actions, reusing the
   `/inbox` section components. Ordered by HITL criticality then age
   (`ATN-07`).
5. **Work in flight** — the work table's row component, full width on desktop.
6. **Activity** — the cross-project feed, beside Decisions on desktop.

Liveness comes from one `EventSource` on the attention stream; the regions
refetch on a tick and never hold an accumulated event list.

## States

```mermaid
stateDiagram-v2
    [*] --> Empty: no projects
    [*] --> Quiet: projects exist, decisions is zero
    [*] --> Busy: decisions is greater than zero
    Quiet --> Busy: a decision opens
    Busy --> Quiet: the last decision is answered
    Empty --> Quiet: first project registered
    note right of Empty
        onboarding checklist and empty-state card
        inside the Desk frame, composer absent
    end note
```

Narrow viewports stack Decisions, then Work, then Activity (`EDGE-NAV-02`).

## Data & APIs

- Decision queue and both counters — see
  [`system-analytics/attention.md`](../system-analytics/attention.md).
- Work rows and stages — see
  [`system-analytics/work-stages.md`](../system-analytics/work-stages.md).
- Liveness — `GET /api/attention/stream`.
- Inline actions reuse the existing promote / recover / discard / HITL-respond
  routes. The Desk adds **no new mutation path**.

## i18n

`desk`, plus the existing `attention`, `work`, `activityFeed` and `inbox`
namespaces for the composed regions. Count-bearing client templates use
`$count`; numeric totals render through `Intl.NumberFormat(locale)`.

## Linked artifacts

- [ADR-171](../decisions.md#adr-171) · [ADR-168](../decisions.md#adr-168) · [ADR-170](../decisions.md#adr-170)
- [`system-analytics/home-navigation.md`](../system-analytics/home-navigation.md)
- [`system-analytics/attention.md`](../system-analytics/attention.md)
- [`work.md`](work.md) · [`activity.md`](activity.md) · [`inbox.md`](inbox.md)
