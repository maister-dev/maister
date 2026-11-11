# Regression validation

This report separates the original full-suite checkpoint from the current
rebased checks. The historical broad runs below use
`f38053b3192a24738c8b0920852cfd229c56721f` plus the cleanup changes; their failures
have corrected complete-owner reruns. The branch is now rebased onto master
`9b5fb6c3d5c6401220fd5c9662fdaf71aeac300e`, retaining its session-retirement fixes,
qualified external-token launch, human Librarian launch, and three-part isolation
matrix.
Local macOS ARM64; this does not qualify hosted CI or the Linux VPS.
Evidence directory: the local `MAISTER_TEST_EVIDENCE_DIR` used for this run.
Raw failed and successful invocations remain separate outside the repository.

## Rebased checks

The Node 24.22.3 one-worker profile passes 8,981 unit/component tests in 872
files, all 41 runtime/CI contracts, all four package lint configurations with
zero warnings, and the full web typecheck. A clean normal Next 16.4.6 production
build passes in 38.225 s with TypeScript enabled and no Turbopack warnings.
Real filesystem/private-publication/evidence checks initially passed 97/99;
two failure-injection cases compared strings against Node file URLs. After
normalizing Node's PathLike argument, the complete 23-case operational-integrity
owner passes. The remaining 76 cases passed in the original invocation.

ESLint 10.14 uses maintained React/DOM/JSX, accessibility, import and stylistic
plugins instead of legacy compatibility wrappers. Active hook, accessibility,
unused-import and import-boundary rules remain enabled. JSX ordering uses
Perfectionist because the Stylistic equivalent is deprecated. The public-site
tab handler is attached to focusable tabs.

Mintlify's old common/Sucrase/glob/inflight chain is absent. Drizzle Kit's unused
esbuild-kit loader declaration is removed with a version-scoped dependency
removal; its real TypeScript config/schema export passes through tsx. The final
audit has zero advisories and the peer graph has no compatibility issues.
There are 1,413 lockfile resolutions versus 1,894 before cleanup. The remaining
upstream deprecation is Mintlify's optional keytar/prebuild-install credential
storage dependency; no incompatible API alias or log filtering is used.

CI runs PR updates and master pushes once, cancelling superseded work. The
expensive A/B web inventory runs on 24.22.3; runtime/supervisor and compatibility
checks cover 26.13.1. Current browser results follow; earlier checkpoint counts
below are not attributed to the rebased source.

The complete rebased ordinary browser suite passes **278/278** in 393.859 s
including setup and cleanup, with zero retries, skips and owned process leaks.
Initial invocations exposed six stale selectors/metadata assertions and then
one hidden-page Flow editor race. The final complete rerun uses accessible
main/board/rail scopes, the expanded modal opener and the visible 404 result;
access refusal, real API status and form behavior assertions remain intact.
Both failed invocations are retained separately. The final full typecheck and
lint of the corrected browser owners pass.

Hosted Librarian acceptance at `0824293e816960f538bf04d76cc8243736ae6d6c`
passes 14/14 on Linux x64/Node 24.22.3, including master's human-launch contract,
with zero owned leaks. Qualification of the final source is reported by
[PR #39 checks](https://github.com/maister-dev/maister/pull/39/checks), including
the label-enabled full integration remainder. Workflow cancellation skips the
combined isolation gate only for cancelled runs; failed parts still reach its
failure-closed report check. Docker builds receive the worker limit through an
explicit build argument.

GitHub Actions use checkout 7.0.1, setup-node 7.1.0, pnpm/action-setup 6.1.1,
upload-artifact 7.0.2 and download-artifact 8.0.2, replacing the Node 20 action
runtime and its deprecated toolkit dependencies. Node is installed before pnpm
for the Intel macOS pnpm 11 boundary; pnpm owns the lockfile-keyed store cache.
All 41 runtime/CI contracts pass after the action migration. The public Next
site also builds without warnings in 4.242 s.

The PostgreSQL follow-up replaces fire-and-forget `connect` declarations with
the pool's awaited `onConnect` hook in the web client, migration CLI and shared
fixtures. The existing writer-floor owner first fails under
`NODE_OPTIONS=--throw-deprecation` against the queued declaration. After the
fix, all 22 cases across writer-floor, operational upgrade and fixture lifecycle
owners pass with deprecations fatal and zero leaks. The writer-floor case now
checks concurrent real writes. A normal production build after this follow-up
passes in 36.633 s with one worker, TypeScript enabled and zero build warnings;
full typecheck, MCP tests and 518 supervisor unit cases pass as well. Explicit
`.ts` imports remove Vite's native-config warnings. The browser checkpoint above
precedes this database follow-up; its final browser rerun is reported on the PR.

Upstream native-toolchain notices remain visible: Mintlify's optional
keytar/prebuild-install uses a deprecated filesystem constant, and the optional
cpu-features native build emits a Node-header cast warning. Debian slim images
also report absent manual-page alternatives. No incompatible dependency alias,
native-feature removal or warning suppression is used for these notices.

Evidence: `production-build.log`, `web-unit.log`, `web-lint-zero.log`,
`root-contracts-final.log`, `integration-paths.log`,
`operational-integrity-fixed.log`, `drizzle-export-configured.log`,
`audit-final.log`, `peers-final.log`, `e2e-full-final.json`,
`e2e-full-final.log`, `final-web-typecheck.log`, `cancellation-contract.log`,
`ci-librarian-0824293.log` in the rebased evidence directory.

## Resource profile

Final follow-up checks run sequentially with:

```sh
MAISTER_TEST_MAX_WORKERS=1
MAISTER_BUILD_MAX_WORKERS=1
NODE_OPTIONS=--max-old-space-size=4096
```

Initial broad runs used two build workers and Node 24.15.0. Follow-ups use
Node 24.22.3 or 26.13.1 and the patched lockfile. Across the final one-worker browser invocations, sampled peaks were
3,562 MiB (ordinary), 6,070 MiB (Node 26 A/B) and 6,658 MiB (Librarian).
An earlier ordinary invocation sampled 6,033 MiB. These five-second samples exclude Docker/OS and vary with
cache state. The earlier two-build-worker peak of 7,777 MiB left too little
headroom, hence the final setting of one. Worker counts and per-process V8
heaps do not enforce an 8 GiB total-RSS or four-CPU cap; Turbopack native threads
are outside the page-data/prerender worker control. Unset controls preserve
local defaults. Commands live in the canonical [shared-host guide](../../docs/system-analytics/test-infrastructure.md#validation-on-a-shared-host).

## Original checkpoint: results

| Lane | Result | Evidence under the root above |
| --- | --- | --- |
| Full web integration remainder, 599 files | Initial 5,155/5,156; corrected complete Librarian owner passes 17/17, shuffle seed 9752 | `web-remainder.log`, `maister-ab-web-nXLv4d/vitest.json`, `librarian-turn-fixed.json` |
| Full web A/B integration, 46 files | Initial 679/681; both corrected complete owners pass in the 165-case rerun | `web-ab.log`, `maister-ab-web-6loyPW/vitest.json` |
| Corrected A/B and runtime owners, 8 files | 165/165, no skips/leaks, 1,203.341 s including cleanup | `integration-owners-qualified.log`, `maister-ab-web-XzVyBF/vitest.json` |
| Production boot and diagnostics after temporary-root removal | 6/6; all 8 logs readable after fixture-root removal, zero leaks | `boot-archives-qualified.log` |
| Isolation preflight | Passed, 3.588 s including cleanup | `isolation-preflight-qualified.log` |
| Full Darwin production isolation, 7 files | 51/51, zero leaks, 546.441 s including cleanup | `isolation-qualified.log`, `maister-ab-isolation-xV2vLp/vitest.json` |
| Full supervisor integration, 39 files | 375/375 on both majors; Node 26 99.164 s including cleanup, zero leaks | `supervisor-integration.log`, `supervisor-node26-qualified.log` |
| Full MCP integration | 12/12 on both majors; Node 26 1.170 s including runner | `mcp-integration.log`, `mcp-node26-qualified.log` |
| Full ordinary E2E, 92 files | Node 24.22.3: 272/272, 371.908 s | `e2e-qualified-clean.json` and `.log` |
| Full execution A/B E2E | Node 26.13.1: 5/5, 23.1 s | `e2e-ab-node26.json` and `.log` |
| Full Librarian E2E | Node 24.22.3: 14/14, 148.463 s | `e2e-librarian-dispatched.json` and `.log` |
| Node 26 compatibility integration, 4 files | 23/23, 56.577 s including cleanup | `node26-compatibility.log`, `maister-ab-web-Naa3nb/vitest.json` |
| Full web unit/component on Node 26, 872 files | 8,979/8,979, 211.48 s | `node26-web-unit.log` |
| Root runtime/CI contracts | 41/41 | `final-root-runtime-ci.log` |
| Patched esbuild-kit transform API | Sync and async TS output executes and returns 42 | `final-esbuild-kit-api.log` |

All three final browser lanes have zero skips, retries, flaky cases and owned
process leaks. Initial complete remainder/A/B lanes also used no retries/skips
and ended with zero leaks, taking 61.8 and 62.5 minutes respectively. Failures
are reported above rather than relabeling those full invocations as green.
A previous eight-file run was interrupted and has no final report; it is not a
pass. Root CI checks initially encountered sandbox `listen EPERM`; the rerun
with local-socket access passes all 41 checks.

## Original checkpoint: corrected findings

- **Event consumer lifetime:** cold `localHost({db: tx})` could start a background
  consumer using a transaction client that was released at commit. Events were
  accepted while cursors remained null, leaving Runs stuck Running. Transactional
  resolution now registers without publishing a shared memo or starting ingestion;
  the next pooled issuer activates it. Consumers reject transaction handles.
  The existing real Postgres/supervisor integration first failed against the old
  code, then passed 4/4 after the fix, including contiguous and ACK cursor checks.
  See `consumer-transaction-red.log` and `consumer-transaction-fixed.log`.
- **Recovery synchronization:** queued agent inputs raced a fixed 15-second
  terminal delay while three real senders started. The existing controlled ACP
  terminal barrier now releases only after admission and launcher death. FIFO,
  duplicate suppression, exactly three prompts and final idle state remain
  asserted. Consensus tests await actual zero live sessions after result
  application. The Librarian queued-successor assertion uses the existing
  20-second completion budget instead of Vitest's implicit one second.
- **Build/process ownership:** ordinary and A/B browsers now use invocation-owned
  production builds instead of `next dev`. SIGTERM shutdown and `exec node`
  wrappers keep Playwright's observed process alive through fixture teardown.
  The final clean run records fixture stop before the zero-leak sweep; the leak
  gate was not weakened. Build and startup-refusal logs are archived before
  temporary fixture roots are removed.
- **Browser drift and independence:** locators target current accessible
  main/table/region/dialog surfaces, preserving strict uniqueness despite hidden
  Next page-cache copies. Review journeys own separate mutable fixtures; RBAC
  uses an independent member account; Workbench checks its own branch and actual
  PR number. Launch cases use current previews, qualified requests and receipts.
  One passing CSS-class comparison was removed; branch/criticality data checks
  remain. The workspace rail now retains usable height beneath active agents.
- **Librarian launch:** L03 no longer calls obsolete `run_launch` without revision,
  settings or qualification. It arms the choice, accepts a real assessment through
  HTTP, reads launch options and calls `task_launch`. The scripted ACP agent reads
  `task_launch_status` and `run_get` until dispatch before ending the turn. Current
  authorization requires a live turn until dispatch; ending at acceptance had
  correctly held the intent as `launch_authority_revoked`. No production token
  check was loosened. Exactly one Run and both non-launch alternatives are checked.
- **Failure traces:** dedicated Playwright configs retain first-failure traces;
  `on-first-retry` collected nothing with retries disabled.

## Original checkpoint: Node and dependencies

CI uses Node 24.22.3 for the expensive two-shard A/B inventory, removing two
redundant Node 24 minor-version jobs. Runtime/supervisor checks cover 24.22.3
and 26.13.1. Node 26 adds full web unit, four real integration owners and A/B
browser coverage. The accepted runtime range is `>=24.15.0 <25 || >=26.13.0 <27`.
The Docker image remains Node 24, pinned to the published official 24.22.2
bookworm-slim digest; the 24.22.3 image tag was unavailable at verification.
No image build or hosted workflow dispatch was performed.

Mintlify `mint` 4.2.1126 → 4.3.17 removes `@mintlify/common`, Sucrase 3.34,
glob 7 and inflight. Owner-scoped pins patch Sharp 0.35.5, js-yaml 4.3.2,
esbuild 0.25.12, glob 14.0.4 and minimatch 11.0.8 until their owners update.
No inflight/lru-cache API alias or warning suppression is used.

- Audit: **zero vulnerabilities**, versus seven advisory entries after the
  Mintlify upgrade but before scoped pins (four high, three moderate).
- Lockfile: **1,449 resolutions versus 1,894**, 445 fewer. This is not an
  install-size or RSS measurement.
- Frozen installation and updated Mintlify build/validation pass.
- Real Sharp resize/PNG metadata, Archiver glob inclusion/exclusion, Drizzle
  schema export and both esbuild-kit transform APIs pass.
- Remaining upstream deprecations: `@esbuild-kit/core-utils`,
  `@esbuild-kit/esm-loader`, optional keytar's `prebuild-install`. ESLint 9 is
  unsupported; installed React/import plugins only declare peers through 9,
  so ESLint 10 needs a coordinated plugin/config migration.

Evidence: `dependency-audit-fixed.json`, `dependency-frozen-install.log`,
`dependency-api-smoke.log`, `drizzle-schema-export.sql`,
`mintlify-patched-validate.log`, and `final-esbuild-kit-api.log`.

## Original checkpoint boundaries

The final normal production build passes with type checking enabled and one
page-data/prerender worker (38.273 s, including 17.0 s TypeScript). Full web,
supervisor and MCP typechecks pass, as do scoped ESLint, documentation contracts,
public Mintlify links and whitespace checks. See `final-progress.log` and
`final-*.log`. The build still emits 33 filesystem-tracing warnings about dynamic
runtime paths and broad patterns. Reducing those traces requires checking the
runtime packaging boundary; no blanket trace exclusions or warning suppression
were added. Earlier measurements are in the [test-model audit](test-model-audit.md).

Linux-only isolation, opt-in load qualification, paid live-provider tests,
image builds, hosted CI and actual VPS resource enforcement were not run.
Local ARM64 results do not replace those platform/release receipts.
