# Platform-agents vs capability subagents — separation + structural editor

Date: 2026-06-21
Status: implemented 2026-06-21 (package-side scope; `/agents` catalog untouched
per the non-goals). Note: the structural agent editor already existed
(`FrontmatterArtifactEditor` `agent_definition` branch) — the work was routing
`maister-agents/*.md` to it + a lenient schema warn badge, plus the inventory /
BOM / viewer-tab / detail-route split.

## Problem

A flow package can carry two different `.md` "agent" kinds, but the package
viewer conflates them:

- **Capability subagents** — Claude-subagent `.md` (`name`/`description`/
  `tools`/`model`/`permissionMode`/`skills`) under `capability/**/agents/`.
  They are flow-internal: materialized into the run's `.claude/agents/` at
  launch for the Claude SDK to discover. Every real package (aif, superpowers,
  bmad) ships these.
- **Platform-agents** — MAIster's standalone/triggerable agents with the strict
  platform frontmatter (`workspace`/`mode`/`triggers`/`risk_tier`/…).

Today the package viewer's "Agents" tab lists the **capability subagents** as if
they were platform-agents, parses them with the strict platform schema, and
hard-fails (`parseAgentDefinition` throws → "could not read"). A graceful raw-md
fallback was already shipped, but the two kinds are still conflated and there is
no structural editor for platform-agents.

## Current substrate (as mapped)

- Capability subagents: `collectInventory` (`web/lib/packages/attach.ts:89`)
  scans `<pkg>/<cap.path>/agents/*.md` → `manifest.inventory.agents` → package
  viewer BOM (`getStudioPackageBom`) + materialized to `.claude/agents/` via
  `copyBundleArtifactsToWorktree` (`web/lib/capabilities/materialize-bundle.ts:41`).
- Platform-agents: `web/lib/agents/registry.ts` scans
  `<flow-revision.installedPath>/agents/*.md`, qualifies `<flowRefId>:<stem>`,
  upserts the `agents` table → the standalone `/agents` admin catalog (M34).
  **No installed package ships `<flow>/agents/`, so 0 platform-agents exist.**

These are two independent code paths. The `/agents` catalog/registry is a
**separate subsystem** from the package viewer.

## Target model

- **Platform-agents** live in a package-level **`maister-agents/<stem>.md`**
  with the platform frontmatter. Surfaced in the package viewer's **"Агенты"**
  tab with the rich structured view, and editable through a **structural
  (form) editor**.
- **Capability subagents** stay at `capability/**/agents/` → materialized into
  `.claude/agents/` at run (unchanged), surfaced in a new **"Сабагенты"** tab
  as raw `.md` (the already-shipped graceful view), labeled "materialized into
  `.claude/` at run."
- **Everything stays editable even with invalid frontmatter**: lenient parse →
  fill the form with what's valid → ⚠ warn badge on invalid/missing → save
  best-effort. Never hard-block.

## Scope (this change)

In scope — the **package side**:

1. **Convention + classification.** `maister-agents/<stem>.md` → a platform-agent
   file; `capability/**/agents/*.md` → a subagent file. Discriminate by path
   (the two frontmatter formats are incompatible, so they cannot share a form).
2. **Manifest + inventory.** `collectInventory` additionally scans the
   package-root `maister-agents/` → a new `inventory.platformAgents: string[]`;
   `inventory.agents` keeps meaning "capability subagents."
3. **BOM (`getStudioPackageBom`).** Emit `platformAgents` (parsed, rich) +
   `subagents` (id + lenient name/description, never throws). Capability-aware
   paths reused.
4. **Viewer tabs.** "Агенты" = `platformAgents` (rich `AgentView`, links to the
   platform-agent detail); "Сабагенты" = capability subagents (raw `.md`
   detail). Hide-empty per existing rule.
5. **Detail routes.** Platform-agent detail → rich `AgentView`; subagent detail
   → raw `.md` (already shipped). Routed by folder.
6. **Structural editor.** A form for `maister-agents/*.md` in the local package
   editor (`/studio/edit`): the 10 platform frontmatter fields (name,
   description, runner, workspace, workspace_ref, mode, triggers[],
   capability_profile, risk_tier, recommended) + prompt body. Lenient parse,
   warn badge, save via a lenient serializer (`serializeFrontmatter`, no strict
   round-trip gate so an invalid draft still persists). Routed by folder:
   `maister-agents/*.md` → structural form; `capability/agents/*.md` → the
   current raw/frontmatter editor.
7. **Graceful everywhere.** No view/edit path hard-fails on bad frontmatter.
8. Tests (unit for classification + lenient render + BOM split), i18n EN+RU,
   docs (`docs/system-analytics/agents.md`).

Explicit **non-goals** (separate follow-up):

- Wiring `maister-agents` platform-agents into the standalone `/agents` catalog
  + `registry.ts` (the M34 per-flow `<flowRefId>:<stem>` substrate stays as-is —
  untouched, so no shipped behavior regresses).
- Launching/triggering platform-agents from `maister-agents`.
- Migrating existing packages (they simply get 0 platform-agents; their
  `capability/agents` move from the "Agents" tab to the "Сабагенты" tab — no
  on-disk change).

## Risks / mitigations

- **Inventory shape change** (`platformAgents` added): additive; existing
  `inventory.agents` semantics preserved → BOM/viewer keep working. Re-install
  not required (BOM reads inventory; new field defaults to `[]` for old installs
  until re-scanned — handled with `?? []`).
- **Classification by path**: `maister-agents/` is a new top-level segment;
  `classifyPackageFilePath` must not mistake it for the capability `agents/`
  segment. Unit-tested.
- **Lenient save** producing invalid frontmatter: acceptable by design (warn
  badge); the strict parse still gates the rich VIEW (falls back to raw).

## Open questions

(none — folder name `maister-agents/`, full package-side scope, and separate
"Сабагенты" tab are confirmed.)
