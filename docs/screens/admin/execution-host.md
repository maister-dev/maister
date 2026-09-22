# Execution host diagnostics

- **Type:** screen (global admin).
- **Route:** `/admin/execution-host`.
- **Status:** Implemented (P0-7, 2026-09-22).
- **Source:** `web/app/(app)/admin/execution-host/page.tsx`,
  `web/components/admin/execution-host-status.tsx`.

## JTBD

When an execution run appears stuck, I need one platform page that says whether
the host is ready, event ingestion or projection is behind, a consumer is
poisoned, durable workers are alive, accepted commands are open, and the
scheduler clock is running.

## Roles and navigation

The request proxy performs a fresh DB-authoritative active-admin lookup before
the route can stream, and `requireGlobalRole("admin")` rechecks the same policy
before the detailed collector. A global admin receives the page. An
authenticated member/viewer, including a live-demoted prior admin session,
receives literal HTTP 403 with no diagnostic payload. Anonymous access keeps
the existing login boundary. The admin left rail and the admin form of the
platform-status pill link here; non-admins receive only the coarse health-only
lag decoration.

The scheduler panel links to `/admin/scheduler`; run rows link to authorized run
details. There is no API or mutation route for this screen.

## Layout

1. Host row: readiness/reason, key, boot, last seen, version and capabilities.
2. Stream row: state, manager watermarks, host head/unACKed/age/pressure,
   last error, claim owner/expiry and separately labeled lag verdict.
3. Top 20 eligible consumer/run backlogs with exact totals and truncation.
4. Stable poison pagination, including terminal runs. A complete row exposes a
   copy-only, shell-quoted `execution:projection:rearm` command containing
   consumer, run, event, cursor and error generation. Invalid evidence renders
   an explanation and no command.
5. Current-process durable worker health plus the latest persisted sweep
   snapshot; each is labeled with observer and sample time.
6. Open command counts, oldest accepted age and timestamped last-sweep impasse.
7. Scheduler clock summary and link.

## States and data

The RSC renders live, host-down-with-manager-evidence, unsupported-old-host,
partial/stale and empty states; route failures use the existing app error
boundary. Ready and behind may be true together; lag never disables launch.
Tables scroll within their panels at narrow widths, and every colored state has
text. EN/RU catalogs have identical keys.

Host health is sampled separately from one read-only Postgres observation and
is not presented as an atomic snapshot. The host and stream listings are capped
at the 20 most recent rows rather than paged; only the poison list paginates.
Only the supported local host is contacted. Current projection ownership comes
from active assignments. The chrome summary uses the request-cached `/health`
sample only and makes no consumer/history query.

Panels degrade independently. The host list, the lag collector and the stored
sweep observation are read concurrently and settled separately, so a collector
that exceeds its SQL budget — the condition an operator most often opens this
page to diagnose — renders one unavailable panel while the host rows, the
stored sweep evidence, worker health and the clock summary stay visible.

Authorization is enforced in two places, and the pair is NOT redundant —
measured, not assumed. `proxy.ts` re-reads the current user before React starts
streaming and rewrites to `/access-denied/execution-host` with a literal HTTP
403; that rewrite is what actually sets the status. Removing it and relying on
the page's `forbidden()` alone was tried and answers **200** on a production
build (`clock-boot.integration.test.ts` E1 catches it; both Playwright 403 specs
run under `next dev` and do not), so `experimental.authInterrupts` renders the
boundary without the status this contract requires.

The page's own check is the second half and closes the role-change race: its
read calls `requireGlobalRole("admin")` BEFORE it parses the poison cursor or
issues any query, so an unauthorized caller cannot distinguish a malformed
cursor from a well-formed one, and a demotion between the proxy read and the
render is still refused.

## Acceptance

- Admin direct and client navigation render all panels in EN and RU.
- Authenticated member/viewer navigation is HTTP 403 and does not serialize the
  detailed DTO.
- Poison evidence exactly matches the rearm command; missing generation/event
  produces no unsafe command.
- Expanded, collapsed and mobile rail links work and do not add a second host
  request or a heavy database query.
- A member sees the coarse platform summary in both rail states with NO link to
  this page, and the rail omits the admin nav entry entirely.
- Playwright owns the admin, member, live-demotion, EN/RU and three rail-mode
  cases in `admin-execution-host.spec.ts`; the explicit `AUTHED_SPEC` entry
  keeps the file out of the unauthenticated project. The literal 403 is
  additionally qualified against a PRODUCTION build in
  `clock-boot.integration.test.ts`, since `authInterrupts` behaves differently
  under `next dev`.
