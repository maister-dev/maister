# Releasing MAIster

MAIster follows [SemVer](https://semver.org/). While on 0.x (public beta),
MINOR releases may contain breaking changes; PATCH releases are fixes only.
All 0.x tags carry a `-beta.N` pre-release suffix (e.g. `v0.1.0-beta.1`) and
are marked as pre-releases on GitHub.

> **Status: beta until v1.0.** The beta ends at v1.0.0, gated on full
> multi-host support.

The product version (git tags) is independent from `MAISTER_ENGINE_VERSION`,
which versions the Flow package compatibility contract. An engine version bump
is always called out explicitly in the release notes.

## Cadence

Releases are cut from `master` when a functional milestone is ready — there is
no fixed calendar cadence. Each MINOR release has one clear theme that fits in
a single sentence of the release notes. Hotfix PATCH releases may happen at
any time.

## Process

1. **Freeze.** CI is green on `master`; run `pnpm validate:docs` and
   `pnpm validate:contracts`, plus the web and supervisor test suites.
2. **Changelog.** Move `[Unreleased]` entries in `CHANGELOG.md` to a new
   `## [0.X.Y-beta.N] - YYYY-MM-DD` section; start a fresh empty
   `[Unreleased]`; update the compare links at the bottom.
3. **Version.** Bump `version` in the root `package.json` (single source of
   truth; workspace packages stay private and keep their own versions).
4. **Upgrade notes.** If the release range includes database migrations or an
   engine version bump, add an explicit "Upgrading" section to the release
   notes: what changes, what requires manual steps.
5. **Tag.** Annotated tag on the changelog commit:
   `git tag -a v0.X.Y-beta.N -m "MAIster v0.X.Y-beta.N"`, then push the tag.
6. **GitHub Release.** Create a Release from the tag; the body is the
   changelog section plus the Upgrading block. Mark `-beta.N` tags as
   pre-releases.
7. **Deploy.** Update the reference instance to the tag (database backup
   first). The reference instance always runs the latest release or newer —
   MAIster dogfoods its own delivery.

Tags are immutable. A broken release is followed by a PATCH, never re-tagged.
