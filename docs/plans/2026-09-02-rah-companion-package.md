# RAH companion package — handoff

**Status:** Pending (authored after this repo merges — Q9-B)
**Decision:** [ADR-165](../decisions/adr-165.md)
**Target repo:** `/repos/maister-plugins`, package `packages/rah`

## Why this is a pointer, not a plan

The recursive-harness reference workflow ships in TWO places on purpose, and
only one of them is in this repository.

- **In-repo** — `web/test-fixtures/rah/`. A test fixture: five flow manifests,
  two schema documents, four read-only researcher agents. It exists so the
  contract tests and the scenario matrix drive a REAL package through the REAL
  loader. It is deliberately not installable production content; REQ-23 keeps
  production Flow packages out of this repository.
- **Companion** — `maister-plugins/packages/rah`. The installable article: the
  same D16 graphs with production prompts, `core` runner profiles, the package
  `result_profiles` block, and a README carrying the install/enable steps and
  the Evaluation Lab protocol run.

Keeping the fixture in-repo is what makes the harness testable; keeping the
package out is what keeps this repository free of shipped third-party content.
They must not drift, which is why the fixture's structural safety properties are
asserted (`web/lib/__tests__/rah-fixture-contract.test.ts`) rather than assumed —
the companion is authored FROM the fixture, so a fixture that stops meaning what
it claims would carry the error outward.

## What the companion must carry

| Piece | Source in this repo |
| --- | --- |
| `maister-package.yaml` with `result_profiles: { research: ./schemas/research-result.v1.json }` | `web/test-fixtures/rah/maister-package.yaml` |
| `schemas/research-result.v1.json`, `schemas/reduce-result.v1.json` | same directory |
| `flows/rah-root-d1`, `flows/rah-root-d2`, `flows/rah-research` | `web/test-fixtures/rah/flows/` |
| `flows/single-agent`, `flows/externalized-context` (the Lab's control arms) | same |
| `maister-agents/{architecture,dependency,test,risk}-researcher.md` | `web/test-fixtures/rah/maister-agents/` |
| `compat.engine_min: 3.7.0` on every manifest | the RAH engine floor |

Two invariants the companion inherits and MUST NOT relax:

- **`max_depth` is ABSOLUTE from the tree root**, min-merged with the root's. A
  flow authored to run as a CHILD declares the depth its own children occupy in
  the whole tree — `rah-research` declares `2`, not the one level it adds.
  Declaring the relative number refuses the very fan-out the flow exists for.
- **The one-writer shape.** Each root graph has exactly one `ai_coding` node;
  every researcher is `workspace: repo_read`; no orchestrator's `tools`
  allow-list admits a subagent tool, and each declares `enforcement.tools:
  strict` with a complete `delegation.budget`. These are what keep a recursive
  tree from becoming concurrent writers over one worktree.

## Sequence

1. This repo merges (ADR-165 / migration `0129` / engine `3.7.0` landed).
2. Author `packages/rah` in `maister-plugins` from the fixture, with production
   prompts and `core` runner profiles.
3. Commit and tag `rah/v1.0.0`. **Push over the one-off HTTPS URL** — SSH push
   fails non-interactively from this environment.
4. Install into a private project, enable, and run the four-arm Lab protocol
   (`docs/system-analytics/evaluations.md` §Recursive-harness comparison
   protocol).

Left uncommitted in `maister-plugins` until step 1 completes: a tagged package
referencing an engine floor no released MAIster satisfies would fail to install.
