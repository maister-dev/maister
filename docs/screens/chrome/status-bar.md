# Status bar

- **Type:** chrome (persistent footer, every `(app)` screen).
- **Status:** Implemented (WI-3 — persistent supervisor-status source).
- **Source:** `web/components/chrome/status-bar.tsx`.

## JTBD

When I am anywhere in the app, I want a single always-visible indicator of
whether the supervisor is reachable — so I know at a glance whether launches and
live runs can proceed.

## Roles & capabilities

No role gate — the footer renders for every authenticated user. It shows status
only; it exposes no mutation. The same coarse behind/unknown field is safe for
every role; only an admin receives a link to execution-host diagnostics.

## Navigation

The platform pill links admins to `/admin/execution-host`; it remains plain text
for other roles. The **Docs** and **GitHub** links open external destinations in
a new tab.

## Layout & regions

Left: the supervisor pill (`PlatformStatusPill`), the host origin
(`localhost:3000`), and the supervisor version when ready. Right: the
attention-stream liveness pill with its reconnect action, then outbound Docs
and GitHub links. Admins also receive the same request-cached coarse status in
the left rail as a direct diagnostics link.

**Narrow (Implemented — `NAV-07`).** Laid out narrow-first like the top nav:
`px-3` and `gap-2` below `md`, widening to `px-6` and `gap-3.5` above it, and
nothing wraps inside the 36px bar. The right group — the liveness pill, the
reconnect action and both links, i.e. every control — never shrinks; the left
group is the elastic one, and within it the supervisor label truncates by CSS
while its full text stays in the DOM (and in the admin link's `aria-label`).
Below `sm` the host is hidden along with the version. Below `md` the Docs and
GitHub links are glyphs (a book, the GitHub mark) whose words stay as `sr-only`
text, so each link's accessible name is the same at every width.

The bar is `position: fixed`, so an overflow here never widens the document —
it clips the links off the right edge, where nothing can reach them, and a
document-width check cannot see it. At 390px it did exactly that (GitHub ended
at 429px in EN, 490px in RU), which is why `E2E-NAV-07` measures each control's
box against the viewport. The worst case it must absorb is RU with the
supervisor lagging and the stream disconnected: a 21-character label beside a
pill and a "Переподключить" button.

## States

```mermaid
stateDiagram-v2
    [*] --> Ready: supervisor reachable
    Ready --> Behind: health sample has old host backlog above threshold
    Behind --> Ready: backlog clears
    Ready --> UnknownLag: host omits stream telemetry
    UnknownLag --> Ready: telemetry block present
    [*] --> Unavailable: network or timeout or http or malformed
    Ready --> Unavailable: health check fails
    Unavailable --> Ready: health check recovers
```

`unknown` means the host reported no stream block at all — a pre-P0-7
supervisor, or one whose telemetry snapshot failed. A host that DOES report,
with nothing outstanding, reads `clear`: the block's age is null exactly at zero
backlog, and that is the healthy steady state, not an absence of information.

## Data & APIs

`getPlatformStatus()` (`lib/execution-host/platform-status.ts`, a cached
`executionHosts.local().platformStatus()` over `checkSupervisorHealth`) — the
same value the layout passes to the rail launch hint. It is the ONLY caller
that opts into the host's stream block; readiness probes deliberately do not,
so a telemetry fault can never refuse a launch. The lag decoration uses only that health response; it does not invoke the
Postgres lag collector. No client polling.

`AttentionLiveRefresh` owns one `GET /api/attention/stream` connection in this
persistent footer. Its ticks refresh the shared sidebar counters and the current
page, including Inbox; see [attention behavior](../../system-analytics/attention.md).
The first connect carries the layout render's cursor and counters (ADR-171 D7),
so a page that is already current gets no tick and is not refreshed.

## i18n

`status` namespace (`supervisorReady`, `supervisorBehind`,
`supervisorUnavailable`, `supervisor`, `docs`), plus the `run.stream*`
liveness labels.

## Linked artifacts

- Behavior: [`../../supervisor.md`](../../supervisor.md) (supervisor daemon),
  [`../../system-analytics/instance-config.md`](../../system-analytics/instance-config.md).
- Source: `web/components/chrome/status-bar.tsx`,
  `web/components/chrome/platform-status.tsx`.
