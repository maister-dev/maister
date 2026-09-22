# Execution host diagnostics

- **Type:** screen (global admin).
- **Route:** `/admin/execution-host`.
- **Status:** Designed (P0-7).
- **Source:** `web/app/(app)/admin/execution-host/page.tsx`,
  `web/components/admin/execution-host-status.tsx`.

## JTBD

When an execution run appears stuck, I need one platform page that says whether
the host is ready, event ingestion or projection is behind, a consumer is
poisoned, durable workers are alive, accepted commands are open, and the
scheduler clock is running.

## Roles and navigation

`requireGlobalRole("admin")` executes before the detailed collector. A global
admin receives the page. An authenticated member/viewer receives literal HTTP
403 with no diagnostic payload. Anonymous access keeps the existing login
boundary. The admin left rail and the admin form of the platform-status pill
link here; non-admins receive only the coarse health-only lag decoration.

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
partial/stale, empty, loading and typed error states. Ready and behind may be
true together; lag never disables launch. Responsive tables remain readable at
narrow widths, and every colored state has text. EN/RU catalogs have identical
keys.

Host health is sampled separately from one read-only Postgres observation and
is not presented as an atomic snapshot. Historical hosts are paged diagnostics;
only the supported local host is contacted. Current projection ownership comes
from active assignments. The chrome summary uses the request-cached `/health`
sample only and makes no consumer/history query.

## Acceptance

- Admin direct and client navigation render all panels in EN and RU.
- Authenticated member/viewer navigation is HTTP 403 and does not serialize the
  detailed DTO.
- Poison evidence exactly matches the rearm command; missing generation/event
  produces no unsafe command.
- Expanded, collapsed and mobile rail links work and do not add a second host
  request or a heavy database query.
