# Implementation Plan: Public readiness and privacy-safe Git history

Branch: `feature/public-readiness`
Created: 2026-09-05

## Objective

Prepare MAIster for a public MIT-licensed GitHub release without discarding its
engineering history. The public repository must explain the project in about
60 seconds, give contributors clear participation and security paths, preserve
the `.ai-factory/` design record, and contain no private email addresses or
previously identified organization/workstation references in any reachable
Git object.

## Settings

- Testing: yes — documentation, YAML, TypeScript, Git integrity, and full-object
  privacy scans.
- Logging: no runtime logging — this is documentation, repository metadata, and
  offline Git-history work only. Audit commands must fail explicitly and print
  the offending object or file.
- Docs: yes — root community files are intentional GitHub community-profile
  surfaces; detailed product documentation remains split between `docs/`
  (engineering) and `site-docs/` (public user documentation).
- Roadmap linkage: none — this is a repository publication gate, not a product
  milestone.

## Privacy and attribution policy

Rewrite author email, committer email, and email-bearing commit-message trailers
through every retained ref.

| Existing identity                    | Public identity                             | Basis                                                                                                         |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Albert Kanishchev / Albert Kanischev | `931977+kanischev@users.noreply.github.com` | Exact GitHub profile and numeric account ID verified through the public GitHub API.                           |
| Staruy                               | `2365702+Staruy@users.noreply.github.com`   | Exact case-insensitive login match and numeric account ID verified through the public GitHub API.             |
| suppermartynov                       | `suppermartynov@noreply.invalid`            | Exact former handle returns no current GitHub account; avoid guessing or attributing commits to another user. |
| Garry Kurnosov                       | `garry-kurnosov@noreply.invalid`            | No exact public GitHub identity found; avoid guessing.                                                        |
| Friday                               | `friday@noreply.invalid`                    | The current `github.com/friday` profile is a different named person; avoid false attribution.                 |

GitHub-generated and tool-generated noreply addresses remain unchanged. Names,
dates, messages, tree contents, and topology remain unchanged except for the
already approved sensitive-text redactions and the email substitutions above.

## Scope boundaries

- Publish `main` as the only public branch initially. Do not publish local
  `backup/**`, `maister/**`, `claude/**`, `codex/**`, or stale feature refs.
- Preserve those sanitized refs in the local mirror until cutover verification
  is complete; they are audit inputs, not public branches.
- Do not invent a support mailbox. Security reports use GitHub private
  vulnerability reporting, with the already public maintainer Telegram link as
  a fallback.
- Do not claim production hardening that the current product documentation lists
  as a productization gap.

## Tasks

### T1. Freeze the sanitized baseline and attribution map

- [x] Record the sanitized mirror tip and enumerate author/committer identities.
- [x] Verify public GitHub accounts without sending private emails to third-party
      search services.
- [x] Define exact GitHub noreply addresses and non-deliverable `.invalid`
      fallbacks for unresolved identities.

Acceptance: every current human email has one unambiguous replacement and no
commit is assigned to a merely similar GitHub profile.

### T2. Make README understandable in 60 seconds

- [x] Replace the long feature inventory with a clear problem, delivery loop,
      concise differentiators, honest maturity boundary, and compact architecture.
- [x] Keep a copy-paste local quick start using commands that exist in the repo.
- [x] Link the product site, public documentation, engineering docs,
      `.ai-factory/` record, contribution guide, security policy, and MIT license.

Acceptance: README is under 150 lines; its first screen answers what MAIster is,
why it matters, and where to start.

### T3. Add community policies

- [x] Add root `CONTRIBUTING.md` with setup, scope, tests, documentation,
      AI-assistance disclosure, and pull-request expectations.
- [x] Add root `SECURITY.md` with supported-version policy, private disclosure
      route, useful report contents, and coordinated-disclosure expectations.
- [x] Add root `CODE_OF_CONDUCT.md` based on Contributor Covenant 2.1 with a
      real private enforcement contact.

Acceptance: GitHub community-profile discovery can find all three files and no
policy directs sensitive reports to a public issue.

### T4. Add GitHub contribution templates

- [x] Add structured bug and feature issue forms with privacy reminders and a
      Code of Conduct acknowledgement.
- [x] Add issue chooser links for documentation, discussions, and private
      vulnerability reporting; disable unstructured blank issues.
- [x] Add a pull-request template covering scope, validation, documentation,
      risk, and material AI assistance.

Acceptance: every YAML form parses and every repository URL targets
`kanischev/mAIster`.

### T5. Connect public surfaces and update the repository map

- [x] Add Contributing, Security, and Code of Conduct links to the EN/RU public
      site footer.
- [x] Update `AGENTS.md` structure and documentation tables for the new public
      community files and `.github/` templates.
- [x] Keep `site/`, `site-docs/`, and internal `docs/` as separate surfaces.

Acceptance: EN/RU content remains structurally aligned, TypeScript compiles, and
the repository map matches the tree.

### T6. Rewrite metadata and run the publication audit

- [x] Commit the public-readiness content with the owner's GitHub noreply
      identity, fast-forward sanitized `main`, then remove the temporary worktree.
- [x] Run `git filter-repo` across every retained ref to replace author,
      committer, and trailer emails.
- [x] Scan every reachable commit, tree, blob, tag, and message for all prior
      private emails plus the sensitive text/path patterns from the first cleanup.
- [x] Run `git fsck --full --strict`, documentation validation, site-docs
      validation, TypeScript checks, and targeted tests.

Acceptance: zero forbidden matches, zero private human emails, clean fsck, and
all relevant validators pass. The `.ai-factory/` historical corpus remains
present, with this plan added as the new publication record.

### T7. Perform the GitHub cutover

- [ ] Authenticate `gh` and Git transport as `kanischev`.
- [ ] Capture the private remote's branch/tag/PR-ref inventory before mutation.
- [ ] Force-update public `main` from the audited mirror and remove every other
      public branch/tag unless explicitly retained and proven sanitized.
- [ ] Configure description, homepage (`https://imaister.dev`), topics, Issues,
      Discussions, private vulnerability reporting, secret scanning/push
      protection, and a protected-main ruleset.
- [ ] Verify the public clone independently, then change repository visibility
      to public.

Acceptance: a fresh unauthenticated clone contains only the intended public
refs, passes the same privacy scan, and GitHub exposes the expected community
and security surfaces.

## Point of no return

The force-update/delete of remote refs and the visibility switch are the two
irreversible publication boundaries. Immediately before them, retain the
original private repository and the audited mirror separately, capture exact
remote refs, and require an explicit action-time confirmation for the visibility
change. After publication, settle forward from the audited history; never merge
old private refs back into public history.

## Commit Plan

- **Commit 1 (T2-T4):** `docs: prepare repository for public contributions`
- **Commit 2 (T5 and plan progress):** `docs(site): connect public community surfaces`
- **Commit 3 (T6):** `docs: record public-readiness verification`
- **History rewrite (T6):** no synthetic content commit; `git filter-repo`
  rewrites both commits and all ancestors in place.

## Progress

- Sanitized source: isolated bare mirror outside the source checkout.
- Pre-email-rewrite sanitized `main`: `0ce7b0ce227804ab712714346f9b05dbf8551384`
- Post-rewrite content tip before this verification record:
  `b82f9632e09bd4a1c4fa35578282a559053e51b9`.
- Full-object privacy audit: 49,328 reachable objects and 24,029 non-tree
  objects scanned; zero legacy-name, company-name, personal-path, or original
  private-email violations.
- Git integrity: `git fsck --full --strict` passed.
- Documentation: 423/423 Mermaid blocks, 831 ADR links, 3,069 relative links,
  121 indexed files, current 109-table ERD, Mintlify build, and Mintlify broken
  links/anchors all passed.
- Code and metadata: web, supervisor, MCP, and site TypeScript checks passed;
  site ESLint and production build passed; issue-form YAML parsed; all newly
  authored Markdown/YAML files passed Prettier check.
- Remote cutover is gated on working GitHub authentication and final
  action-time confirmation for repository visibility.
