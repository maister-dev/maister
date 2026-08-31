# Flow Studio Redesign — Implementation Plan

> **Status: Shipped — Phase B = M35, Phase C = M36; git write-back landed as ADR-113/132. Current truth: `../system-analytics/flow-studio.md`.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unbalanced, flows-only `/flows` page with a unified **Studio** section that surfaces sources, packages (grouped by package), and a merged package-detail view — over the *existing* backend — as the foundation the editor redesign (Phase B) and the editable-local-package backend (Phase C) build on.

**Architecture:** New `/studio/*` routes under the `(app)` route group. Phase A is **frontend over existing data** — it adds no migration and reuses every existing read (`getAvailablePackageInstalls`, `getProjectPackageAttachments`, `getFlowPackageDetail`, `loadPlatformRuntimeView`) and the existing `PackageSourcesPanel` / static `FlowGraphView`. A pure `group-packages` shaper turns today's flow-flat install list into a package-grouped view. The board `?tab=packages` config surface stays put and gains an "Open in Studio" deep-link.

**Tech Stack:** Next.js 16 App Router (RSC + server actions), HeroUI v3, next-intl (`messages/{en,ru}.json`), Drizzle/Postgres, Vitest (`renderToStaticMarkup`, no jsdom), Playwright (stub-supervisor seeded e2e).

**Design SSOT:** [`docs/screens/studio/README.md`](../screens/studio/README.md).

**Scope boundary:** Phase A ships the IA + view/check surfaces. The big-canvas **editor redesign is Phase B**; the **editable local package / standalone artifact kinds / move-to-package backend is Phase C** (see Roadmap). Each becomes its own plan.

**Repo conventions baked in:**
- Web unit tests are `*.test.ts(x)` using `renderToStaticMarkup` (NOT jsdom). Integration uses testcontainers Postgres.
- Lint: run `pnpm --filter maister-web exec eslint .` (check-only). NEVER `pnpm --filter maister-web lint` (that's `eslint --fix` with no path → reformats ~60 files).
- New Playwright specs MUST be added to the `AUTHED_SPEC` regex in `web/playwright.config.ts` or they won't run authenticated.
- Run all commands from the repo root; the worktree is `/repos/mAIster/.claude/worktrees/angry-chaum-31d223`.

---

## File Structure (Phase A)

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `web/lib/studio/group-packages.ts` | Pure shaper: installs + attachments → package-grouped view + needs-attention | Create |
| `web/lib/studio/group-packages.test.ts` | Unit tests for the shaper | Create |
| `web/lib/studio/load.ts` | Studio server reads (wraps existing helpers; no new SQL) | Create |
| `web/app/(app)/studio/page.tsx` | Studio overview (`/studio`) | Create |
| `web/app/(app)/studio/sources/page.tsx` | Sources (`/studio/sources`, admin) — mounts `PackageSourcesPanel` | Create |
| `web/app/(app)/studio/packages/page.tsx` | Packages list (`/studio/packages`), grouped | Create |
| `web/app/(app)/studio/packages/[ref]/page.tsx` | Package detail (BoM + read-only preview + actions) | Create |
| `web/components/studio/overview-cards.tsx` | Overview at-a-glance + area cards + needs-attention | Create |
| `web/components/studio/packages-list.tsx` | Grouped package list + filters | Create |
| `web/components/studio/package-detail.tsx` | BoM + preview + lifecycle actions | Create |
| `web/components/chrome/left-rail.tsx` | Rename "Flows" nav → "Studio", href `/studio` | Modify |
| `web/components/board/panels/flow-packages-panel.tsx` | Add "Open in Studio" link per package | Modify |
| `web/messages/en.json`, `web/messages/ru.json` | New `studio` namespace; `nav.studio` | Modify |
| `web/e2e/studio.spec.ts` | Authenticated e2e walk-through | Create |
| `web/playwright.config.ts` | Register `studio.spec.ts` in `AUTHED_SPEC` | Modify |
| `docs/CLAUDE.md`, `docs/screens/chrome/left-rail.md` | Glossary row + nav rename note | Modify |

---

## Task A1: Studio route group + nav rename

**Files:**
- Create: `web/app/(app)/studio/page.tsx` (stub, fleshed out in A2)
- Modify: `web/components/chrome/left-rail.tsx`
- Modify: `web/messages/en.json`, `web/messages/ru.json`

- [ ] **Step 1: Find the Flows nav entry in the rail**

Run: `grep -n "flows\|nav\." web/components/chrome/left-rail.tsx | head -20`
Expected: a nav item linking `/flows` with a label from the `nav` (or `side`) i18n namespace. Note the exact key and JSX shape.

- [ ] **Step 2: Add the `nav.studio` i18n key (EN + RU)**

In `web/messages/en.json`, under the `nav` object, add:
```json
"studio": "Studio"
```
In `web/messages/ru.json`, under `nav`:
```json
"studio": "Студия"
```

- [ ] **Step 3: Repoint the rail item to Studio**

In `web/components/chrome/left-rail.tsx`, change the Flows nav item's `href` from `/flows` to `/studio` and its label key from the current Flows key to `nav.studio`. Leave the `/flows` route file in place (legacy, unlinked) until Studio reaches parity — do NOT delete it in Phase A.

- [ ] **Step 4: Create the Studio overview stub**

Create `web/app/(app)/studio/page.tsx`:
```tsx
import { getTranslations } from "next-intl/server";

export default async function StudioOverviewPage() {
  const t = await getTranslations("studio");
  return <main aria-label={t("title")}>{t("title")}</main>;
}
```

- [ ] **Step 5: Add the `studio` namespace shell (EN + RU)**

Add a top-level `"studio"` object to both message files with at least `{ "title": "Studio" / "Студия" }` (extended in A8).

- [ ] **Step 6: Verify it renders and lints**

Run: `pnpm --filter maister-web exec next build --no-lint 2>&1 | tail -5` (or `pnpm --filter maister-web dev` and open `/studio`)
Run: `pnpm --filter maister-web exec eslint app/\(app\)/studio components/chrome/left-rail.tsx`
Expected: `/studio` renders "Studio"; rail shows the Studio item; no eslint errors in scope.

- [ ] **Step 7: Commit**

```bash
git add web/app/\(app\)/studio web/components/chrome/left-rail.tsx web/messages/en.json web/messages/ru.json
git commit -m "feat(web): add /studio route group + rename Flows nav to Studio"
```

---

## Task A2: package-grouping shaper (pure, TDD)

**Files:**
- Create: `web/lib/studio/group-packages.ts`
- Test: `web/lib/studio/group-packages.test.ts`

- [ ] **Step 1: Confirm the install + attachment shapes**

Run: `grep -n "getAvailablePackageInstalls\|getProjectPackageAttachments\|packageInstalls\b" web/lib/**/*.ts | head`
Note the field names on a `packageInstalls` row (`id`, `sourceUrl`, `name`, `version`, `resolvedRevision`, `manifest`, `trustStatus`) and on an attachment row (`packageInstallId`, `projectId`). Adjust the types below to match exactly.

- [ ] **Step 2: Write the failing test**

Create `web/lib/studio/group-packages.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { groupPackages } from "./group-packages";

const inst = (o: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...o });
function base() {
  return {
    id: "i1", sourceUrl: "github.com/org/aif", name: "aif",
    version: "v1.0.0", trustStatus: "trusted_by_policy",
    manifest: { flows: [{ id: "aif-dev" }, { id: "aif-init" }], capabilities: [{ kind: "skill", id: "s1" }], mcps: [] },
  };
}

describe("groupPackages", () => {
  it("groups installs by (sourceUrl, name) and counts member artifacts", () => {
    const groups = groupPackages({
      installs: [inst(), inst({ id: "i2", version: "v1.1.0" })],
      attachments: [{ packageInstallId: "i1", projectId: "p1" }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("aif");
    expect(groups[0].versions.map((v) => v.version)).toEqual(["v1.1.0", "v1.0.0"]); // newest first
    expect(groups[0].counts).toEqual({ flows: 2, skills: 1, agents: 0, mcps: 0, rules: 0 });
    expect(groups[0].attachedProjectCount).toBe(1);
  });

  it("flags a local source with the isLocal badge", () => {
    const groups = groupPackages({ installs: [inst({ sourceUrl: "file:///x", version: "local-dev" })], attachments: [] });
    expect(groups[0].isLocal).toBe(true);
  });

  it("marks needs-attention when an install is untrusted", () => {
    const groups = groupPackages({ installs: [inst({ trustStatus: "untrusted" })], attachments: [] });
    expect(groups[0].needsTrust).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter maister-web exec vitest run lib/studio/group-packages.test.ts`
Expected: FAIL — `groupPackages` not found.

- [ ] **Step 4: Implement the shaper**

Create `web/lib/studio/group-packages.ts`:
```ts
export type PackageInstallLike = {
  id: string;
  sourceUrl: string;
  name: string;
  version: string;
  trustStatus: string;
  manifest: { flows?: unknown[]; capabilities?: { kind: string }[]; mcps?: unknown[]; restrictions?: unknown[] } | null;
};
export type AttachmentLike = { packageInstallId: string | null; projectId: string };

export type PackageGroup = {
  key: string;
  name: string;
  sourceUrl: string;
  isLocal: boolean;
  needsTrust: boolean;
  versions: { installId: string; version: string; trustStatus: string }[];
  counts: { flows: number; skills: number; agents: number; mcps: number; rules: number };
  attachedProjectCount: number;
};

const isLocalSource = (url: string) => url.startsWith("file:") || /(^|\/)local-/.test(url);

export function groupPackages(input: {
  installs: PackageInstallLike[];
  attachments: AttachmentLike[];
}): PackageGroup[] {
  const byKey = new Map<string, PackageInstallLike[]>();
  for (const i of input.installs) {
    const key = `${i.sourceUrl}::${i.name}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i);
  }
  const attachByInstall = new Map<string, Set<string>>();
  for (const a of input.attachments) {
    if (!a.packageInstallId) continue;
    (attachByInstall.get(a.packageInstallId) ?? attachByInstall.set(a.packageInstallId, new Set()).get(a.packageInstallId)!).add(a.projectId);
  }
  return [...byKey.entries()].map(([key, installs]) => {
    const versions = [...installs].sort((a, b) => (a.version < b.version ? 1 : -1));
    const newest = versions[0];
    const caps = newest.manifest?.capabilities ?? [];
    const attachedProjects = new Set<string>();
    for (const i of installs) for (const p of attachByInstall.get(i.id) ?? []) attachedProjects.add(p);
    return {
      key,
      name: newest.name,
      sourceUrl: newest.sourceUrl,
      isLocal: isLocalSource(newest.sourceUrl),
      needsTrust: installs.some((i) => i.trustStatus === "untrusted"),
      versions: versions.map((v) => ({ installId: v.id, version: v.version, trustStatus: v.trustStatus })),
      counts: {
        flows: newest.manifest?.flows?.length ?? 0,
        skills: caps.filter((c) => c.kind === "skill").length,
        agents: caps.filter((c) => c.kind === "agent").length,
        rules: caps.filter((c) => c.kind === "rule").length,
        mcps: newest.manifest?.mcps?.length ?? 0,
      },
      attachedProjectCount: attachedProjects.size,
    };
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter maister-web exec vitest run lib/studio/group-packages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add web/lib/studio/group-packages.ts web/lib/studio/group-packages.test.ts
git commit -m "feat(web): add package-grouping shaper for Studio"
```

---

## Task A3: Studio server reads

**Files:**
- Create: `web/lib/studio/load.ts`

- [ ] **Step 1: Identify the existing reads to wrap**

Run: `grep -rn "getAvailablePackageInstalls\|getProjectPackageAttachments\|loadPlatformRuntimeView" web/lib web/app | head`
Confirm signatures. `getProjectPackageAttachments` is per-project — for an instance-wide Studio view, gather attachments across all projects the caller can see (or all, for admin) using the existing project-list helper.

- [ ] **Step 2: Implement the loader**

Create `web/lib/studio/load.ts`:
```ts
import { groupPackages } from "./group-packages";
// import the real helpers found in Step 1, e.g.:
// import { getAvailablePackageInstalls } from "@/lib/packages/installs";
// import { listVisibleProjects } from "@/lib/projects";
// import { getProjectPackageAttachments } from "@/lib/packages/attachments";

export async function loadStudioPackages(viewerId: string) {
  const installs = await getAvailablePackageInstalls();
  const projects = await listVisibleProjects(viewerId);
  const attachments = (
    await Promise.all(projects.map((p) => getProjectPackageAttachments(p.id)))
  ).flat();
  return groupPackages({ installs, attachments });
}
```
Wire the imports to the real module paths from Step 1. If a `listVisibleProjects(viewerId)` helper does not exist, use the existing project-listing read used by the portfolio home and filter by membership.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter maister-web exec tsc --noEmit`
Expected: no new errors from `lib/studio/load.ts`.

- [ ] **Step 4: Commit**

```bash
git add web/lib/studio/load.ts
git commit -m "feat(web): add Studio package loader (wraps existing reads)"
```

---

## Task A4: Studio overview page

**Files:**
- Create: `web/components/studio/overview-cards.tsx`
- Modify: `web/app/(app)/studio/page.tsx`
- Test: `web/components/studio/overview-cards.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `web/components/studio/overview-cards.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewCards } from "./overview-cards";

const groups = [
  { key: "a", name: "aif", isLocal: true, needsTrust: false, counts: { flows: 5, skills: 2, agents: 0, mcps: 0, rules: 0 }, versions: [{ installId: "i", version: "local-dev", trustStatus: "trusted_by_policy" }], attachedProjectCount: 1, sourceUrl: "file:///x" },
  { key: "b", name: "bugfix", isLocal: false, needsTrust: true, counts: { flows: 1, skills: 0, agents: 0, mcps: 0, rules: 0 }, versions: [{ installId: "j", version: "v0.0.1", trustStatus: "untrusted" }], attachedProjectCount: 0, sourceUrl: "github.com/x" },
];

describe("OverviewCards", () => {
  it("shows counts and a needs-attention entry for untrusted packages", () => {
    const html = renderToStaticMarkup(<OverviewCards groups={groups as never} isAdmin={true} />);
    expect(html).toContain("2"); // package count
    expect(html).toContain("bugfix"); // untrusted → needs attention
    expect(html).toContain("/studio/packages");
  });
  it("hides the Sources card for non-admins", () => {
    const html = renderToStaticMarkup(<OverviewCards groups={[] as never} isAdmin={false} />);
    expect(html).not.toContain("/studio/sources");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter maister-web exec vitest run components/studio/overview-cards.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `web/components/studio/overview-cards.tsx` (presentational; HeroUI). It MUST: render a count strip (packages = `groups.length`, local artifacts = groups where `isLocal`, sum of counts); area cards linking `/studio/packages` and `/studio/local`, and `/studio/sources` ONLY when `isAdmin`; a needs-attention list of `groups.filter(g => g.needsTrust)` linking each to `/studio/packages/${encodeURIComponent(g.name)}`. Use the `studio` i18n namespace via `useTranslations` (client) or pass labels as props from the server page. Keep it a server-renderable component (no client-only hooks in the test path).

- [ ] **Step 4: Flesh out the page**

Modify `web/app/(app)/studio/page.tsx` to: resolve the viewer + admin role (`getViewer()` / `requireGlobalRole` probe — use the same auth helper the existing `/flows` page uses, confirm via `grep -n "requireGlobalRole\|getViewer\|auth()" web/app/\(app\)/flows/page.tsx`), call `loadStudioPackages(viewer.id)`, and render `<OverviewCards groups={...} isAdmin={...} />` inside the standard page chrome (eyebrow + `<h1>`), mirroring the `mcps/page.tsx` page-bar pattern.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter maister-web exec vitest run components/studio/overview-cards.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/components/studio/overview-cards.tsx web/components/studio/overview-cards.test.tsx web/app/\(app\)/studio/page.tsx
git commit -m "feat(web): Studio overview (at-a-glance + area cards + needs-attention)"
```

---

## Task A5: Sources at /studio/sources

**Files:**
- Create: `web/app/(app)/studio/sources/page.tsx`

- [ ] **Step 1: Confirm the existing panel + its loader**

Run: `grep -n "PackageSourcesPanel\|loadPlatformRuntimeView\|packageSources\|packageInstalls" web/app/\(app\)/settings/page.tsx web/components/settings/package-sources-panel.tsx | head`
Note the exact props `PackageSourcesPanel` expects and the loader that supplies `sources` + `installs`.

- [ ] **Step 2: Implement the admin-gated page**

Create `web/app/(app)/studio/sources/page.tsx`:
```tsx
import { requireGlobalRole } from "@/lib/authz"; // confirm path in Step 1
import { PackageSourcesPanel } from "@/components/settings/package-sources-panel";
// import the same loader the settings page uses to build the panel props

export default async function StudioSourcesPage() {
  await requireGlobalRole("admin"); // route IS the authz boundary
  const view = await loadPlatformRuntimeView(); // reuse settings loader; pick the package slice
  return (
    <main>
      {/* eyebrow + <h1> via studio i18n, mirroring mcps/page.tsx */}
      <PackageSourcesPanel sources={view.packageSources} installs={view.packageInstalls} />
    </main>
  );
}
```
Wire imports/props to the real names from Step 1. Leave the `/settings` panel intact for now (dedup is a Phase A follow-up note, not a deletion).

- [ ] **Step 3: Verify gating**

Run: `pnpm --filter maister-web exec tsc --noEmit` then load `/studio/sources` as admin (renders panel) and as a member (redirect/UNAUTHORIZED). If an integration test exists for `/mcps` admin gating, mirror it for `/studio/sources`.

- [ ] **Step 4: Commit**

```bash
git add web/app/\(app\)/studio/sources/page.tsx
git commit -m "feat(web): mount package Sources panel at /studio/sources (admin)"
```

---

## Task A6: Packages list /studio/packages

**Files:**
- Create: `web/components/studio/packages-list.tsx`
- Create: `web/app/(app)/studio/packages/page.tsx`
- Test: `web/components/studio/packages-list.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `web/components/studio/packages-list.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PackagesList } from "./packages-list";

const groups = [
  { key: "a", name: "aif", isLocal: true, needsTrust: false, counts: { flows: 5, skills: 2, agents: 0, mcps: 0, rules: 0 }, versions: [{ installId: "i", version: "local-dev", trustStatus: "trusted_by_policy" }], attachedProjectCount: 1, sourceUrl: "file:///x" },
];

describe("PackagesList", () => {
  it("renders one row per package with member counts and a detail link", () => {
    const html = renderToStaticMarkup(<PackagesList groups={groups as never} />);
    expect(html).toContain("aif");
    expect(html).toContain("/studio/packages/aif"); // ref = name
    expect(html).toContain("5"); // flows count
    expect(html).toMatch(/local/i); // Local badge
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter maister-web exec vitest run components/studio/packages-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the list**

Create `web/components/studio/packages-list.tsx`: one row per `PackageGroup` showing name, source, newest version, trust, member-kind count chips (flows/agents/skills/mcps/rules), `attachedProjectCount`, and a `Local` badge when `isLocal`. Each row links to `/studio/packages/${encodeURIComponent(g.name)}`. Include simple client-side filter controls (by source-host, by kind-present, by trust) — a `"use client"` wrapper is fine; keep the row markup in a server-renderable child so the test path stays jsdom-free.

- [ ] **Step 4: Implement the page**

Create `web/app/(app)/studio/packages/page.tsx`: resolve viewer, `loadStudioPackages(viewer.id)`, render `<PackagesList groups={...} />` in the standard page chrome.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter maister-web exec vitest run components/studio/packages-list.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/studio/packages-list.tsx web/components/studio/packages-list.test.tsx web/app/\(app\)/studio/packages/page.tsx
git commit -m "feat(web): Studio packages list grouped by package"
```

---

## Task A7: Package detail /studio/packages/[ref]

**Files:**
- Create: `web/components/studio/package-detail.tsx`
- Create: `web/app/(app)/studio/packages/[ref]/page.tsx`
- Test: `web/components/studio/package-detail.test.tsx`

- [ ] **Step 1: Confirm the detail reads + static graph component**

Run: `grep -n "getFlowPackageDetail\|FlowGraphView\|flow-graph-view-section\|package-fork-button" web/app/\(app\)/projects/\[slug\]/packages/\[flowRefId\]/page.tsx web/components/board/flow-graph-view-section.tsx | head`
Confirm: how the manifest BoM is read, how the static (no-`runContext`) `FlowGraphView` is invoked, and the fork-button props.

- [ ] **Step 2: Write the failing render test**

Create `web/components/studio/package-detail.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageDetail } from "./package-detail";

const pkg = {
  name: "aif", sourceUrl: "file:///x", isLocal: true,
  versions: [{ installId: "i", version: "local-dev", trustStatus: "trusted_by_policy" }],
  bom: { flows: [{ id: "aif-dev" }, { id: "aif-init" }], agents: [], skills: [{ id: "s1" }], mcps: [], rules: [] },
};

describe("PackageDetail", () => {
  it("renders bill-of-materials grouped by kind + a rework action", () => {
    const html = renderToStaticMarkup(<PackageDetail pkg={pkg as never} canManage={true} canTrust={false} />);
    expect(html).toContain("aif-dev");
    expect(html).toContain("s1");
    expect(html).toMatch(/rework|fork/i);
  });
  it("hides Trust for non-admins", () => {
    const html = renderToStaticMarkup(<PackageDetail pkg={pkg as never} canManage={true} canTrust={false} />);
    expect(html).not.toMatch(/\bTrust\b/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter maister-web exec vitest run components/studio/package-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the detail component**

Create `web/components/studio/package-detail.tsx`: header (name · source · versions · trust · Local/Installed badge); a BoM section grouping `bom.{flows,agents,skills,mcps,rules}` with per-row "Open" links (read-only viewer for installed, editor for local — editor wiring lands in Phase B; for Phase A link installed rows to the existing `/projects/{slug}/packages/{flowRefId}` viewer); a **flow preview** region embedding the static `FlowGraphView` (reused from `flow-graph-view-section`) with a flow selector when `bom.flows.length > 1`; lifecycle actions — **Attach to project** (links to the board `?tab=packages`), **Trust** (only when `canTrust`), **Versions** (list + upgrade link), **Fork to local / Rework** (reuse `package-fork-button` for installed; "Edit" for local). Gate management actions on `canManage`.

- [ ] **Step 5: Implement the page (ref resolution)**

Create `web/app/(app)/studio/packages/[ref]/page.tsx`: decode `ref` (`decodeURIComponent`), resolve the package group by `name` via `loadStudioPackages` (Phase A: name is the ref; if two sources expose the same name, render a disambiguation list — note this edge case in a code comment and a follow-up). Build the `bom` from the newest install's `manifest`. Resolve `canManage` (any-project `manageCatalog`) and `canTrust` (global admin). Render `<PackageDetail ... />`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter maister-web exec vitest run components/studio/package-detail.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add web/components/studio/package-detail.tsx web/components/studio/package-detail.test.tsx web/app/\(app\)/studio/packages/\[ref\]/page.tsx
git commit -m "feat(web): Studio package detail (BoM + read-only preview + actions)"
```

---

## Task A8: deep-link, i18n, e2e, docs

**Files:**
- Modify: `web/components/board/panels/flow-packages-panel.tsx`
- Modify: `web/messages/en.json`, `web/messages/ru.json`
- Create: `web/e2e/studio.spec.ts`
- Modify: `web/playwright.config.ts`
- Modify: `docs/CLAUDE.md`, `docs/screens/chrome/left-rail.md`

- [ ] **Step 1: Add "Open in Studio" deep-link on the board**

In `web/components/board/panels/flow-packages-panel.tsx`, add a per-package link to `/studio/packages/${encodeURIComponent(pkgName)}` labelled `studio.openInStudio`. Confirm the package-name field name first: `grep -n "name\|flowRef\|packageName" web/components/board/panels/flow-packages-panel.tsx | head`.

- [ ] **Step 2: Fill the `studio` i18n namespace (EN + RU)**

Add all keys used by the components (`title`, `eyebrow`, `sub`, `packagesTitle`, `localTitle`, `sourcesTitle`, `needsAttention`, `openInStudio`, `attach`, `trust`, `rework`, `versions`, count-chip labels, `localBadge`). EN under `studio` in `en.json`; the SAME keys translated under `studio` in `ru.json`. Run `node -e "JSON.parse(require('fs').readFileSync('web/messages/ru.json'))"` to confirm valid JSON.

- [ ] **Step 3: Register and write the e2e spec**

In `web/playwright.config.ts`, add `studio` to the `AUTHED_SPEC` regex (find it: `grep -n "AUTHED_SPEC" web/playwright.config.ts`). Create `web/e2e/studio.spec.ts` asserting, as a seeded admin: rail "Studio" → `/studio`; overview shows a package count; `/studio/packages` lists `aif`; clicking it reaches `/studio/packages/aif` with a BoM; `/studio/sources` is reachable as admin. Mirror an existing authed spec for the login/seed harness.

- [ ] **Step 4: Run the e2e (kill stale ports first)**

Run: `lsof -ti :3100,:7788 | xargs kill -9 2>/dev/null; pnpm --filter maister-web exec playwright test studio.spec.ts`
Expected: PASS. (Shared e2e infra — ports 3100/7788 + `maister_e2e` DB are shared across worktrees; kill ports first.)

- [ ] **Step 5: Update docs**

In `docs/CLAUDE.md` screen-reference glossary, add a row for `screens/studio/README.md` (Planned → shipped for Phase A surfaces). In `docs/screens/chrome/left-rail.md`, note the Flows→Studio rename and the `/studio` destination. Run `pnpm validate:docs`.

- [ ] **Step 6: Full gate**

Run: `pnpm --filter maister-web exec vitest run lib/studio components/studio` and `pnpm --filter maister-web exec eslint app/\(app\)/studio components/studio components/chrome/left-rail.tsx components/board/panels/flow-packages-panel.tsx`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add web/components/board/panels/flow-packages-panel.tsx web/messages web/e2e/studio.spec.ts web/playwright.config.ts docs/CLAUDE.md docs/screens/chrome/left-rail.md
git commit -m "feat(web): board deep-link + studio i18n + e2e + docs"
```

---

## Self-Review (Phase A)

- **Spec coverage:** Overview (A4) · Sources relocation (A5) · Packages grouped list (A2 shaper + A6) · Package detail merge with read-only preview (A7) · config/content split via board deep-link (A8) · nav rename (A1). The big-canvas **editor** and **local/virtual package** are explicitly Phase B/C — NOT gaps.
- **No new backend / migration in Phase A** — every read is reused; `groupPackages` is pure and fully tested.
- **Type consistency:** `PackageGroup` (A2) is the single shape consumed by A4/A6/A7; `bom` in A7 is derived from `manifest` at the page, not added to `PackageGroup`.
- **Known edge case, flagged in-code:** `ref = name` collisions across two sources → disambiguation list (A7 Step 5). A durable `ref` encoding can land in Phase B if needed.

---

## Roadmap — follow-on plans (write each as its own plan when reached)

### Phase B — Editor usability (storage-agnostic; over existing editor backend)
The **storage-agnostic** editor redesign, over existing flow drafts behind a small load/save **seam**: compact **top bar** (identity · lifecycle · validation · readiness · Save/Publish · `[YAML][Diff]` drawer toggles); **big canvas** (palette, connect, drag-move persisted to `presentation` per ADR-064, zoom/fit/minimap); **right properties panel** (node-intrinsic: Identity · Behavior · Runner · Gates · Transitions · Presentation); **hideable app rail** (chrome change in `left-rail.tsx`); **node card redesign** (icon chips + color coding per the node/gate scheme in the design SSOT, named outcome handles, dashed rework edges). The read-only twin is the package-detail preview (A7). **Excludes** the package-coupled bits — Files drawer, cross-artifact reference pickers, "new artifact", cut-version — which land in Phase C. Reuses `flow-editor-tabs`, `flow-graph-editor`, `artifact-editors/*`, and the unchanged draft/publish/trust API.

### Phase C — Editable local packages (Variant B) + the editor's package-coupled half (NEW backend)
**Data model locked to Variant B:** a `local_packages` table whose row points at a mutable working directory; Studio's file/graph editors edit files in it; **cut local version** runs the existing installer over the dir → an immutable `local-<digest>` `package_installs` revision; projects attach it; the virtual package is the default row; **move-to-package** relocates files between working dirs. Standalone artifact kinds become files in the dir (`flows/ agents/ skills/ mcps/ rules/ schemas/`), each via its per-kind editor. Then the editor's package-coupled half plugs into B's seam: Files drawer, cross-artifact reference pickers, "new artifact in package", and the top-bar cut-version action. Plus `/studio/local`. Phase-0 carries the heavy SDD lift (new `local-packages.md` + ERD in `database-schema.md` + `db/*.md` + migration + OpenAPI + error codes). Full A→B→C rationale + within-C build order in [`.ai-factory/plans/feature-flow-studio-redesign.md`](../../.ai-factory/plans/feature-flow-studio-redesign.md). Write-back to a git source stays Phase 2.

---

## Нерешённые вопросы

1. **Маршрут редактора (Phase B):** новый `/studio/edit/...` или редизайн на месте `/flows/{projectSlug}/{capId}`? (склоняюсь к месту — меньше миграции ссылок).
2. **`/flows` после паритета:** редирект на `/studio` или удалить? Когда?
3. **Sources дублирование:** оставить панель и в `/settings`, и в `/studio/sources`, или убрать из `/settings`?
4. ✓ **РЕШЕНО — Phase C модель данных:** Variant B (новая таблица `local_packages` + рабочая директория; «cut version» через существующий установщик).
5. **`ref` пакета:** имя достаточно, или нужен стабильный `base64url(source::name)` против коллизий имён между источниками?
