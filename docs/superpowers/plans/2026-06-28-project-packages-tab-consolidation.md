# Project Packages Tab Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse a project's redundant **Flows** + **Packages** tabs into one **Packages** tab — keep the attached-packages list, add project-owned local packages as rows, replace the weak per-flow card section with rich per-package contents (flow cards + an element-count line), and route package detail to the Studio view.

**Architecture:** Pure `web/` change. Delete the Flows tab and the bespoke package-install viewer. The Packages tab renders three server-fed sections: the existing `ProjectPackagesSection` (table), a new `ProjectLocalPackages` (rows), and a new `ProjectPackageContents` (per-package flow cards + counts) that reuses Studio's `FlowPreviewCard` and `getStudioPackageBom`. No DB migration, no `supervisor/` change, no API contract change.

**Tech Stack:** Next.js 16 App Router (RSC + `"use client"`), React 19, HeroUI v3 / Tailwind 4, Drizzle, `next-intl`, vitest (unit/integration), Playwright (e2e).

## Global Constraints

- **TypeScript strict.** No `any` unless flagged `// FIXME(any):` (match the existing `schemaModule as unknown as Record<string, any>` pattern already in the query files).
- **i18n EN + RU parity is mandatory.** Every new message key MUST be added to BOTH `web/messages/en.json` and `web/messages/ru.json`. Parity is enforced by the unit suite.
- **Default to Server Components.** Add `"use client"` only when a component needs hooks/state or passes a translator function to a client child.
- **Reuse existing tokens/components.** Tailwind forest tokens (`bg-paper`, `border-line`, `text-ink`, `text-mute`, `bg-ivory`, `border-amber`, etc.), `@heroicons/react` for any glyph, `next/link` for navigation. No new component libraries.
- **Surgical changes.** Every changed line traces to this plan. Do not reformat or "improve" adjacent code.
- **Lint gating:** NEVER run bare `pnpm lint` (it is `eslint --fix` with no path → rewrites 100+ unrelated drift files). Gate with check-only `pnpm exec eslint <explicit-paths>`.
- **Commits:** Conventional Commits. Do NOT append a `Co-Authored-By` / AI trailer (project convention).
- **Run from `web/`** unless a step says otherwise.

---

## File map

**Create:**
- `web/lib/queries/project-local-packages.ts` — `getProjectLocalPackages(projectId)` projection.
- `web/lib/queries/__tests__/project-local-packages.test.ts`
- `web/lib/queries/project-package-contents.ts` — `getProjectPackageContents(projectId)` aggregator.
- `web/lib/queries/__tests__/project-package-contents.test.ts`
- `web/components/board/panels/project-local-packages.tsx` — local-packages rows (server component).
- `web/components/board/panels/__tests__/project-local-packages.test.ts`
- `web/components/board/panels/project-package-contents.tsx` — per-package contents blocks (client component).
- `web/components/board/panels/__tests__/project-package-contents.test.ts`

**Modify:**
- `web/components/board/project-tabs.tsx` — drop `flows`.
- `web/app/(app)/projects/[slug]/page.tsx` — drop flows branch; rework packages branch.
- `web/components/board/panels/project-packages-section.tsx` — name link → Studio; drop redundant button.
- `web/components/board/panels/__tests__/project-packages-section.test.ts` — update href assertion.
- `web/components/studio/package-detail.tsx` — `export` `FlowPreviewCard`.
- `web/messages/en.json` + `web/messages/ru.json` — new `packages.*` keys.

**Delete:**
- `web/components/board/panels/flows-panel.tsx` + `web/components/board/panels/__tests__/flows-panel.test.ts`
- `web/components/board/panels/flow-packages-panel.tsx` + `web/components/board/panels/__tests__/flow-packages-panel.test.ts`
- `web/app/(app)/projects/[slug]/package-installs/` (the whole route dir)

**Known dead code left in place (flag, do NOT delete — surgical):** after Task 6, `getFlowPackages` (`web/lib/queries/flow-packages.ts`) and the `packages.title`/`install`/`enable`/`disable`/`viewer*` i18n keys lose their last consumer. Leave them; note in the final commit body.

---

### Task 1: Remove the Flows tab

**Files:**
- Modify: `web/components/board/project-tabs.tsx`
- Modify: `web/app/(app)/projects/[slug]/page.tsx` (imports + flows render branch)
- Delete: `web/components/board/panels/flows-panel.tsx`
- Delete: `web/components/board/panels/__tests__/flows-panel.test.ts`

**Interfaces:**
- Produces: a `ProjectTab` union and `TABS` array with no `"flows"` member.

- [ ] **Step 1: Drop `flows` from `project-tabs.tsx`**

In `web/components/board/project-tabs.tsx`, remove `"flows"` from the `ProjectTab` union (line 12), from the `TABS` array (line 34), and from the `label` record (line 58 `flows: t("flows"),`). Leave every other tab untouched. (Do NOT touch `messages/*.json` `nav.flows` — the global left-rail `/flows` nav still uses it.)

- [ ] **Step 2: Remove the flows branch + import from `page.tsx`**

In `web/app/(app)/projects/[slug]/page.tsx` delete the import line 19:

```tsx
import { FlowsPanel } from "@/components/board/panels/flows-panel";
```

and delete the entire flows render branch (lines 437–443):

```tsx
      {tab === "flows" ? (
        <FlowsPanel
          canManageCatalog={isAdmin}
          flows={pageData.flows}
          projectSlug={slug}
        />
      ) : null}
```

Keep the `getFlowPackages` import (still used by `FlowPackagesPanel` until Task 6).

- [ ] **Step 3: Delete the Flows panel + its test**

```bash
git rm web/components/board/panels/flows-panel.tsx \
       web/components/board/panels/__tests__/flows-panel.test.ts
```

- [ ] **Step 4: Verify no dangling references**

Run: `cd web && grep -rn '"flows"\|FlowsPanel\|flows-panel' app components | grep -v node_modules`
Expected: NO matches in `components/board/project-tabs.tsx`, `app/(app)/projects/[slug]/page.tsx`, or any `flows-panel` path. (Matches under `nav`/left-rail for the global `/flows` route are fine and expected.)

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: exit 0 (the union change forces every `tab === "flows"` site to be gone; tsc catches stragglers).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(packages): drop the redundant project Flows tab"
```

---

### Task 2: Route package detail to Studio; delete the bespoke viewer

**Files:**
- Modify: `web/components/board/panels/project-packages-section.tsx:200-231`
- Modify: `web/components/board/panels/__tests__/project-packages-section.test.ts:70`
- Delete: `web/app/(app)/projects/[slug]/package-installs/` (whole dir)

**Interfaces:**
- Produces: attached-package name links now point at `/studio/packages/<encoded name>`.

- [ ] **Step 1: Update the failing test expectation first**

In `web/components/board/panels/__tests__/project-packages-section.test.ts`, line 70, replace:

```ts
    expect(markup).toContain("/projects/demo/package-installs/att-1");
```

with:

```ts
    expect(markup).toContain("/studio/packages/aif");
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-packages-section.test.ts`
Expected: FAIL — markup still contains the old `package-installs` href, not `/studio/packages/aif`.

- [ ] **Step 3: Repoint the name link + drop the now-redundant Studio button**

In `web/components/board/panels/project-packages-section.tsx`, change the package-name link (lines 200–203) from:

```tsx
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/projects/${slug}/package-installs/${att.id}`}
                      >
                        {att.packageName}
                      </Link>
```

to:

```tsx
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/studio/packages/${encodeURIComponent(att.packageName)}`}
                      >
                        {att.packageName}
                      </Link>
```

Then delete the now-duplicate "Open in Studio" action button (lines 226–231) — the whole `<Link … href={`/studio/packages/${encodeURIComponent(att.packageName)}`}>{tStudio("openInStudio")}</Link>` block inside the actions cell. If `tStudio` (`useTranslations("studio")`, line 62) becomes unused after this, remove that line too (tsc/eslint will flag it).

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-packages-section.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete the bespoke viewer route**

```bash
git rm -r "web/app/(app)/projects/[slug]/package-installs"
```

- [ ] **Step 6: Verify no inbound links remain**

Run: `cd web && grep -rn "package-installs" app components lib | grep -v node_modules`
Expected: NO matches.

- [ ] **Step 7: Typecheck + commit**

Run: `cd web && pnpm typecheck`
Expected: exit 0.

```bash
git add -A
git commit -m "feat(packages): link attached packages to the Studio view, drop the bespoke package-install page"
```

---

### Task 3: `getProjectLocalPackages` query

**Files:**
- Create: `web/lib/queries/project-local-packages.ts`
- Create: `web/lib/queries/__tests__/project-local-packages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProjectLocalPackageOrigin =
    | { kind: "forked"; packageName: string; versionLabel: string }
    | { kind: "local" };
  export type ProjectLocalPackageView = {
    id: string; name: string; slug: string; isDefault: boolean;
    origin: ProjectLocalPackageOrigin;
  };
  export function getProjectLocalPackages(projectId: string): Promise<ProjectLocalPackageView[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/lib/queries/__tests__/project-local-packages.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => Promise.resolve(dbState.rows) }),
      }),
    }),
  }),
}));

vi.mock("@/lib/local-packages/service", () => ({
  listSourceInstallsForLocalPackages: async () =>
    new Map([["inst-9", { id: "inst-9", name: "aif", versionLabel: "aif/v1.0.0" }]]),
}));

import { getProjectLocalPackages } from "@/lib/queries/project-local-packages";

afterEach(() => {
  dbState.rows = [];
});

describe("getProjectLocalPackages", () => {
  it("projects rows and resolves forked vs local origin", async () => {
    dbState.rows = [
      { id: "lp-1", name: "aif (local)", slug: "aif-local", isDefault: true, sourceInstallId: "inst-9" },
      { id: "lp-2", name: "scratch", slug: "scratch", isDefault: false, sourceInstallId: null },
    ];

    const result = await getProjectLocalPackages("proj-1");

    expect(result).toEqual([
      {
        id: "lp-1",
        name: "aif (local)",
        slug: "aif-local",
        isDefault: true,
        origin: { kind: "forked", packageName: "aif", versionLabel: "aif/v1.0.0" },
      },
      {
        id: "lp-2",
        name: "scratch",
        slug: "scratch",
        isDefault: false,
        origin: { kind: "local" },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd web && pnpm exec vitest run --project unit lib/queries/__tests__/project-local-packages.test.ts`
Expected: FAIL with "Cannot find module '@/lib/queries/project-local-packages'".

- [ ] **Step 3: Write the implementation**

Create `web/lib/queries/project-local-packages.ts`:

```ts
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { listSourceInstallsForLocalPackages } from "@/lib/local-packages/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/queries/packages.ts).
const { localPackages } = schemaModule as unknown as Record<string, any>;

export type ProjectLocalPackageOrigin =
  | { kind: "forked"; packageName: string; versionLabel: string }
  | { kind: "local" };

export type ProjectLocalPackageView = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  origin: ProjectLocalPackageOrigin;
};

// Project-owned local packages (the per-project default + project forks),
// active only, newest first. Surfaced as rows on the project Packages tab; the
// working-dir contents live in the Studio editor (no BOM compiler here).
export async function getProjectLocalPackages(
  projectId: string,
): Promise<ProjectLocalPackageView[]> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(localPackages)
    .where(
      and(
        eq(localPackages.projectId, projectId),
        eq(localPackages.status, "active"),
      ),
    )
    .orderBy(desc(localPackages.updatedAt));

  const sourceInstalls = await listSourceInstallsForLocalPackages(rows);

  return rows.map((row: any): ProjectLocalPackageView => {
    const source = row.sourceInstallId
      ? sourceInstalls.get(row.sourceInstallId)
      : undefined;

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isDefault: row.isDefault,
      origin: source
        ? {
            kind: "forked",
            packageName: source.name,
            versionLabel: source.versionLabel,
          }
        : { kind: "local" },
    };
  });
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd web && pnpm exec vitest run --project unit lib/queries/__tests__/project-local-packages.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `cd web && pnpm typecheck && pnpm exec eslint lib/queries/project-local-packages.ts lib/queries/__tests__/project-local-packages.test.ts`
Expected: exit 0, no eslint errors.

```bash
git add web/lib/queries/project-local-packages.ts web/lib/queries/__tests__/project-local-packages.test.ts
git commit -m "feat(packages): add getProjectLocalPackages projection"
```

---

### Task 4: Local packages subsection + wire into the page

**Files:**
- Create: `web/components/board/panels/project-local-packages.tsx`
- Create: `web/components/board/panels/__tests__/project-local-packages.test.ts`
- Modify: `web/app/(app)/projects/[slug]/page.tsx` (packages branch + imports)
- Modify: `web/messages/en.json` + `web/messages/ru.json` (`packages.local*` keys)

**Interfaces:**
- Consumes: `ProjectLocalPackageView[]` from Task 3.
- Produces: `ProjectLocalPackages({ localPackages })` — async server component; renders nothing when the list is empty.

- [ ] **Step 1: Add i18n keys (EN + RU)**

In `web/messages/en.json`, inside the `"packages"` object (after `"detach": "Detach",` ~line 2461), add:

```json
    "localTitle": "Local packages",
    "localBadge": "Local",
    "localOriginForked": "Forked from {package}@{version}",
    "localOriginLocal": "Created locally",
    "localEdit": "Edit",
```

In `web/messages/ru.json`, inside the matching `"packages"` object, add:

```json
    "localTitle": "Локальные пакеты",
    "localBadge": "Локальный",
    "localOriginForked": "Форк из {package}@{version}",
    "localOriginLocal": "Создан локально",
    "localEdit": "Изменить",
```

- [ ] **Step 2: Write the failing test**

Create `web/components/board/panels/__tests__/project-local-packages.test.ts`:

```ts
import type { ReactElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import { ProjectLocalPackages } from "@/components/board/panels/project-local-packages";

describe("ProjectLocalPackages", () => {
  it("renders rows with badge, origin, and an edit link to the Studio editor", async () => {
    const markup = renderToStaticMarkup(
      (await ProjectLocalPackages({
        localPackages: [
          {
            id: "lp-1",
            name: "aif (local)",
            slug: "aif-local",
            isDefault: true,
            origin: { kind: "forked", packageName: "aif", versionLabel: "aif/v1.0.0" },
          },
        ],
      })) as ReactElement,
    );

    expect(markup).toContain("localTitle");
    expect(markup).toContain("aif (local)");
    expect(markup).toContain("localBadge");
    expect(markup).toContain("/studio/edit/lp-1");
  });

  it("renders nothing when there are no project-owned local packages", async () => {
    const result = await ProjectLocalPackages({ localPackages: [] });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-local-packages.test.ts`
Expected: FAIL with "Cannot find module '@/components/board/panels/project-local-packages'".

- [ ] **Step 4: Write the component**

Create `web/components/board/panels/project-local-packages.tsx`:

```tsx
import type { ProjectLocalPackageView } from "@/lib/queries/project-local-packages";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

// Project-owned local packages (M39 centralized drafts that belong to this
// project). Rows only — their contents are edited in Studio, not rendered here.
export async function ProjectLocalPackages({
  localPackages,
}: {
  localPackages: ProjectLocalPackageView[];
}): Promise<ReactElement | null> {
  if (localPackages.length === 0) return null;

  const t = await getTranslations("packages");

  return (
    <section className="mb-6 rounded-[16px] border border-line bg-paper p-6">
      <h3 className="mb-4 m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("localTitle")}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {localPackages.map((pkg) => (
          <li
            key={pkg.id}
            className="flex items-center justify-between gap-3 rounded-[10px] border border-line-soft bg-ivory px-4 py-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-ink">
                {pkg.name}
              </span>
              <span className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                {t("localBadge")}
              </span>
              <span className="font-mono text-[11px] text-mute">
                {pkg.origin.kind === "forked"
                  ? t("localOriginForked", {
                      package: pkg.origin.packageName,
                      version: pkg.origin.versionLabel,
                    })
                  : t("localOriginLocal")}
              </span>
            </div>
            <Link
              className="shrink-0 rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-paper"
              href={`/studio/edit/${pkg.id}`}
            >
              {t("localEdit")}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-local-packages.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Wire into the page**

In `web/app/(app)/projects/[slug]/page.tsx`, add the imports (next to the other panel imports near line 18 and the query import near line 36):

```tsx
import { ProjectLocalPackages } from "@/components/board/panels/project-local-packages";
```
```tsx
import { getProjectLocalPackages } from "@/lib/queries/project-local-packages";
```

Then, in the packages branch (currently lines 458–473), insert `ProjectLocalPackages` between `ProjectPackagesSection` and `FlowPackagesPanel`:

```tsx
      {tab === "packages" ? (
        <>
          <ProjectPackagesSection
            attachments={await getProjectPackageAttachments(project.id)}
            availableInstalls={await getAvailablePackageInstalls()}
            canTrust={canTrustPackages}
            isAdmin={isAdmin}
            slug={slug}
          />
          <ProjectLocalPackages
            localPackages={await getProjectLocalPackages(project.id)}
          />
          <FlowPackagesPanel
            isAdmin={isAdmin}
            packages={await getFlowPackages(project.id)}
            slug={slug}
          />
        </>
      ) : null}
```

- [ ] **Step 7: Typecheck, i18n parity, lint, commit**

Run: `cd web && pnpm typecheck && pnpm exec vitest run --project unit messages`
Expected: typecheck exit 0; the i18n parity test in the unit suite passes (EN/RU keys match).

Run: `cd web && pnpm exec eslint components/board/panels/project-local-packages.tsx components/board/panels/__tests__/project-local-packages.test.ts "app/(app)/projects/[slug]/page.tsx"`
Expected: no eslint errors.

```bash
git add -A
git commit -m "feat(packages): show project-owned local packages on the Packages tab"
```

---

### Task 5: `getProjectPackageContents` aggregator query

**Files:**
- Create: `web/lib/queries/project-package-contents.ts`
- Create: `web/lib/queries/__tests__/project-package-contents.test.ts`

**Interfaces:**
- Consumes: `getProjectPackageAttachments` + `getStudioPackageBom` + `PackageBomFlow` (all from `@/lib/queries/packages`).
- Produces:
  ```ts
  export type ProjectPackageContentView = {
    packageName: string;
    versionLabel: string;
    flows: PackageBomFlow[];
    counts: { skills: number; agents: number; subagents: number; mcps: number; rules: number };
  };
  export function getProjectPackageContents(projectId: string): Promise<ProjectPackageContentView[]>;
  ```
  (`counts.agents` = `bom.platformAgents.length`.)

- [ ] **Step 1: Write the failing test**

Create `web/lib/queries/__tests__/project-package-contents.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachments: vi.fn(),
  bom: vi.fn(),
}));

vi.mock("@/lib/queries/packages", () => ({
  getProjectPackageAttachments: mocks.attachments,
  getStudioPackageBom: mocks.bom,
}));

import { getProjectPackageContents } from "@/lib/queries/project-package-contents";

const flow = {
  id: "dev",
  path: "flows/dev",
  nodeCount: 2,
  gateCount: 0,
  engine: null,
  frontmatter: { title: null, summary: null, labels: [], routeWhen: null, links: [], sources: [] },
  graph: null,
};

describe("getProjectPackageContents", () => {
  it("returns per-package flows + non-flow counts, dropping packages with no readable BOM", async () => {
    mocks.attachments.mockResolvedValue([
      { packageInstallId: "inst-1", packageName: "aif", versionLabel: "aif/v1.0.0" },
      { packageInstallId: "inst-missing", packageName: "ghost", versionLabel: "ghost/v1" },
    ]);
    mocks.bom.mockImplementation(async (id: string) =>
      id === "inst-1"
        ? {
            flows: [flow],
            platformAgents: [{ id: "p1" }, { id: "p2" }],
            subagents: [{ id: "s1" }],
            skills: [{ id: "k1" }, { id: "k2" }, { id: "k3" }],
            mcps: [{ id: "m1" }],
            rules: [],
          }
        : null,
    );

    const result = await getProjectPackageContents("proj-1");

    expect(result).toEqual([
      {
        packageName: "aif",
        versionLabel: "aif/v1.0.0",
        flows: [flow],
        counts: { skills: 3, agents: 2, subagents: 1, mcps: 1, rules: 0 },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd web && pnpm exec vitest run --project unit lib/queries/__tests__/project-package-contents.test.ts`
Expected: FAIL with "Cannot find module '@/lib/queries/project-package-contents'".

- [ ] **Step 3: Write the implementation**

Create `web/lib/queries/project-package-contents.ts`:

```ts
import "server-only";

import type { PackageBomFlow } from "@/lib/queries/packages";

import {
  getProjectPackageAttachments,
  getStudioPackageBom,
} from "@/lib/queries/packages";

export type ProjectPackageContentView = {
  packageName: string;
  versionLabel: string;
  flows: PackageBomFlow[];
  counts: {
    skills: number;
    agents: number;
    subagents: number;
    mcps: number;
    rules: number;
  };
};

// Per-attached-package contents for the project Packages tab: flow cards (rich
// BOM) + counts for the other artifact kinds. A package whose bundle is gone
// (null BOM) is dropped rather than shown empty. BOM reads run in parallel.
export async function getProjectPackageContents(
  projectId: string,
): Promise<ProjectPackageContentView[]> {
  const attachments = await getProjectPackageAttachments(projectId);
  const blocks = await Promise.all(
    attachments.map(async (att): Promise<ProjectPackageContentView | null> => {
      const bom = await getStudioPackageBom(att.packageInstallId);

      if (!bom) return null;

      return {
        packageName: att.packageName,
        versionLabel: att.versionLabel,
        flows: bom.flows,
        counts: {
          skills: bom.skills.length,
          agents: bom.platformAgents.length,
          subagents: bom.subagents.length,
          mcps: bom.mcps.length,
          rules: bom.rules.length,
        },
      };
    }),
  );

  return blocks.filter((b): b is ProjectPackageContentView => b !== null);
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd web && pnpm exec vitest run --project unit lib/queries/__tests__/project-package-contents.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `cd web && pnpm typecheck && pnpm exec eslint lib/queries/project-package-contents.ts lib/queries/__tests__/project-package-contents.test.ts`
Expected: exit 0, no eslint errors.

```bash
git add web/lib/queries/project-package-contents.ts web/lib/queries/__tests__/project-package-contents.test.ts
git commit -m "feat(packages): add getProjectPackageContents aggregator"
```

---

### Task 6: Per-package contents section + remove the old Flow Packages panel

**Files:**
- Modify: `web/components/studio/package-detail.tsx` (export `buildGraphLabels` L356 + `FlowPreviewCard` L406)
- Create: `web/components/board/panels/project-package-contents.tsx`
- Create: `web/components/board/panels/__tests__/project-package-contents.test.ts`
- Modify: `web/app/(app)/projects/[slug]/page.tsx` (packages branch + imports)
- Modify: `web/messages/en.json` + `web/messages/ru.json` (`packages.contents*` + `count*` keys)
- Delete: `web/components/board/panels/flow-packages-panel.tsx` + its test

**Interfaces:**
- Consumes: `ProjectPackageContentView[]` (Task 5); `FlowPreviewCard` (newly exported) + `ElementCardLabels` from `@/components/studio/element-card`; `FlowGraphViewLabels` from `@/components/board/flow-graph-view`.
- Produces: `ProjectPackageContents({ contents, slug })` — client component; renders nothing when `contents` is empty.

- [ ] **Step 1: Export `FlowPreviewCard` and `buildGraphLabels`**

In `web/components/studio/package-detail.tsx`, export the two helpers the new
section reuses (so the new component does NOT duplicate the ~40-line graph-label
mapping that already lives here):

- Line 356: `function buildGraphLabels(` → `export function buildGraphLabels(`
- Line 406: `function FlowPreviewCard({` → `export function FlowPreviewCard({`

(Everything else in that file stays. `package-detail.tsx` is already `"use client"`,
so both exports are client-safe. `buildGraphLabels` takes a `useTranslations`-shaped
translator, which the new client component supplies via `useTranslations("workbench")`.)

- [ ] **Step 2: Add i18n keys (EN + RU)**

In `web/messages/en.json`, inside `"packages"`, add (after the `local*` keys from Task 4):

```json
    "contentsTitle": "Package contents",
    "countSkills": "{count} skills",
    "countAgents": "{count} agents",
    "countSubagents": "{count} subagents",
    "countMcps": "{count} MCPs",
    "countRules": "{count} rules",
```

In `web/messages/ru.json`, inside `"packages"`, add:

```json
    "contentsTitle": "Содержимое пакетов",
    "countSkills": "{count} навыков",
    "countAgents": "{count} агентов",
    "countSubagents": "{count} субагентов",
    "countMcps": "{count} MCP",
    "countRules": "{count} правил",
```

- [ ] **Step 3: Write the failing test**

Create `web/components/board/panels/__tests__/project-package-contents.test.ts`. It mocks `FlowPreviewCard` (the heavy graph card) to a stub so the test isolates the section's own structure — blocks, the Studio link, the flow-card href, and the count line:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals && "count" in vals ? `${vals.count} ${key}` : key,
}));
vi.mock("@/components/studio/package-detail", () => ({
  FlowPreviewCard: ({ href }: { href: string }) =>
    createElement("a", { "data-testid": "flow-card", href }, "flow"),
}));

import { ProjectPackageContents } from "@/components/board/panels/project-package-contents";

describe("ProjectPackageContents", () => {
  it("renders a per-package block with a Studio link, flow cards, and a count line", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackageContents, {
        slug: "demo",
        contents: [
          {
            packageName: "aif",
            versionLabel: "aif/v1.0.0",
            flows: [
              {
                id: "dev",
                path: "flows/dev",
                nodeCount: 2,
                gateCount: 0,
                engine: null,
                frontmatter: { title: null, summary: null, labels: [], routeWhen: null, links: [], sources: [] },
                graph: null,
              },
            ],
            counts: { skills: 3, agents: 2, subagents: 0, mcps: 1, rules: 0 },
          },
        ],
      }),
    );

    expect(markup).toContain("contentsTitle");
    expect(markup).toContain("/studio/packages/aif");
    expect(markup).toContain("/projects/demo/packages/dev");
    // Non-zero kinds only, joined " · ".
    expect(markup).toContain("3 countSkills");
    expect(markup).toContain("2 countAgents");
    expect(markup).toContain("1 countMcps");
    expect(markup).not.toContain("countSubagents");
    expect(markup).not.toContain("countRules");
  });

  it("renders nothing when there is no package content", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackageContents, { slug: "demo", contents: [] }),
    );

    expect(markup).toBe("");
  });
});
```

- [ ] **Step 4: Run the test — verify it fails**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-package-contents.test.ts`
Expected: FAIL with "Cannot find module '@/components/board/panels/project-package-contents'".

- [ ] **Step 5: Write the component**

Create `web/components/board/panels/project-package-contents.tsx`. It reuses the
exported `FlowPreviewCard` + `buildGraphLabels` from `package-detail.tsx` — no
local graph-label duplication:

```tsx
"use client";

import type { ElementCardLabels } from "@/components/studio/element-card";
import type { ProjectPackageContentView } from "@/lib/queries/project-package-contents";
import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  buildGraphLabels,
  FlowPreviewCard,
} from "@/components/studio/package-detail";

// Per-package contents on the project Packages tab: rich flow cards (reusing
// Studio's FlowPreviewCard) + a non-flow artifact count line. Flow cards link to
// the project-scoped per-flow viewer (`flow.id` === `flows.flowRefId`); the block
// header links to the Studio package view for the full skill/agent/MCP detail.
export function ProjectPackageContents({
  contents,
  slug,
}: {
  contents: ProjectPackageContentView[];
  slug: string;
}): ReactElement | null {
  const t = useTranslations("studio");
  const tWorkbench = useTranslations("workbench");
  const tPackages = useTranslations("packages");

  if (contents.length === 0) return null;

  const cardLabels: ElementCardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };
  const graphLabels = buildGraphLabels(tWorkbench);

  return (
    <section className="mb-6 rounded-[16px] border border-line bg-paper p-6">
      <h3 className="mb-4 m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {tPackages("contentsTitle")}
      </h3>
      <div className="flex flex-col gap-6">
        {contents.map((pkg) => {
          const countParts = [
            pkg.counts.skills > 0
              ? tPackages("countSkills", { count: pkg.counts.skills })
              : null,
            pkg.counts.agents > 0
              ? tPackages("countAgents", { count: pkg.counts.agents })
              : null,
            pkg.counts.subagents > 0
              ? tPackages("countSubagents", { count: pkg.counts.subagents })
              : null,
            pkg.counts.mcps > 0
              ? tPackages("countMcps", { count: pkg.counts.mcps })
              : null,
            pkg.counts.rules > 0
              ? tPackages("countRules", { count: pkg.counts.rules })
              : null,
          ].filter((part): part is string => part !== null);

          return (
            <div
              key={pkg.packageName}
              className="rounded-[14px] border border-line-soft bg-ivory p-4"
              data-testid="package-contents-block"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink">
                    {pkg.packageName}
                  </span>
                  <span className="font-mono text-[11px] text-mute">
                    {pkg.versionLabel}
                  </span>
                </div>
                <Link
                  className="shrink-0 rounded-[8px] border border-line bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-amber"
                  href={`/studio/packages/${encodeURIComponent(pkg.packageName)}`}
                >
                  {t("openInStudio")}
                </Link>
              </div>

              {pkg.flows.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {pkg.flows.map((flow) => (
                    <FlowPreviewCard
                      key={flow.id}
                      flow={flow}
                      graphLabels={graphLabels}
                      href={`/projects/${slug}/packages/${encodeURIComponent(flow.id)}`}
                      labels={cardLabels}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}

              {countParts.length > 0 ? (
                <p className="mt-3 m-0 font-mono text-[11.5px] text-mute">
                  {countParts.join(" · ")}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `cd web && pnpm exec vitest run --project unit components/board/panels/__tests__/project-package-contents.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Swap the panel in the page, delete the old one**

In `web/app/(app)/projects/[slug]/page.tsx`:

Remove the `FlowPackagesPanel` import (line 17) and the `getFlowPackages` import (line 36). Add the new imports:

```tsx
import { ProjectPackageContents } from "@/components/board/panels/project-package-contents";
```
```tsx
import { getProjectPackageContents } from "@/lib/queries/project-package-contents";
```

Replace the `FlowPackagesPanel` block in the packages branch with `ProjectPackageContents`, so the branch reads:

```tsx
      {tab === "packages" ? (
        <>
          <ProjectPackagesSection
            attachments={await getProjectPackageAttachments(project.id)}
            availableInstalls={await getAvailablePackageInstalls()}
            canTrust={canTrustPackages}
            isAdmin={isAdmin}
            slug={slug}
          />
          <ProjectLocalPackages
            localPackages={await getProjectLocalPackages(project.id)}
          />
          <ProjectPackageContents
            contents={await getProjectPackageContents(project.id)}
            slug={slug}
          />
        </>
      ) : null}
```

Delete the old panel + test:

```bash
git rm web/components/board/panels/flow-packages-panel.tsx \
       web/components/board/panels/__tests__/flow-packages-panel.test.ts
```

- [ ] **Step 8: Verify no dangling references**

Run: `cd web && grep -rn "FlowPackagesPanel\|flow-packages-panel" app components | grep -v node_modules`
Expected: NO matches.

- [ ] **Step 9: Typecheck, i18n parity, lint, commit**

Run: `cd web && pnpm typecheck && pnpm exec vitest run --project unit messages`
Expected: typecheck exit 0; i18n parity passes.

Run: `cd web && pnpm exec eslint components/board/panels/project-package-contents.tsx components/board/panels/__tests__/project-package-contents.test.ts components/studio/package-detail.tsx "app/(app)/projects/[slug]/page.tsx"`
Expected: no eslint errors.

```bash
git add -A
git commit -m "feat(packages): render per-package contents (flow cards + counts), remove the Flow Packages panel

getFlowPackages and the legacy packages.title/install/enable/disable/viewer* i18n keys are now unused; left in place per surgical-change policy."
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: exit 0.

- [ ] **Step 2: Full unit suite (incl. i18n parity)**

Run: `cd web && pnpm test:unit`
Expected: all pass; no references to deleted modules.

- [ ] **Step 3: Integration suite (real Postgres)**

Run: `cd web && pnpm test:integration`
Expected: all pass (this change adds no integration tests but must not break existing ones).

- [ ] **Step 4: Lint (check-only, scoped to touched files)**

Run:
```bash
cd web && pnpm exec eslint \
  components/board/project-tabs.tsx \
  components/board/panels/project-packages-section.tsx \
  components/board/panels/project-local-packages.tsx \
  components/board/panels/project-package-contents.tsx \
  components/studio/package-detail.tsx \
  lib/queries/project-local-packages.ts \
  lib/queries/project-package-contents.ts \
  "app/(app)/projects/[slug]/page.tsx"
```
Expected: no errors. (Do NOT run bare `pnpm lint`.)

- [ ] **Step 5: Live smoke check (dev server on :3000)**

With `pnpm --filter maister-web dev` running, open a project board → **Packages** tab and confirm:
- There is NO **Flows** tab in the tab rail.
- **Attached packages** table renders; a package name links to `/studio/packages/<name>` (no `/package-installs/...`).
- **Local packages** subsection appears only when the project owns local packages; each row links to `/studio/edit/<id>`.
- **Package contents** shows one block per attached package: a *View in Studio* header link, a `FlowPreviewCard` per flow whose *View* opens `/projects/<slug>/packages/<flowId>` (resolves, not 404), and a `· `-joined count line of the non-zero non-flow kinds.

(If `:3000` is busy with another `next dev`, free it first — Next 16 refuses a second dev server for the same project dir.)

- [ ] **Step 6: Final review commit (if any cleanup landed)**

Only if Step 5 surfaced a fix. Otherwise the feature branch is complete.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-28-project-packages-tab-consolidation-design.md`):
- Drop Flows tab → Task 1. ✓
- Repoint package row to Studio + delete `/package-installs/[id]` → Task 2. ✓
- Project-owned local packages as rows → Tasks 3–4. ✓
- Per-package contents (flow cards + count line), no Install/Upgrade/Disable → Tasks 5–6. ✓
- Reuse `FlowPreviewCard` + `getStudioPackageBom` → Task 6 / Task 5. ✓
- EN+RU i18n → Tasks 4 & 6. ✓
- Out-of-scope (no local BOM compiler, no migration, no backend change) → respected (local = rows; queries only read). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `ProjectLocalPackageView` (Task 3) consumed unchanged in Task 4. `ProjectPackageContentView` (Task 5) consumed unchanged in Task 6. `counts.agents` is consistently `bom.platformAgents.length` in both the Task 5 impl, the Task 5 test, and the Task 6 component/test. `FlowPreviewCard` props (`flow`, `href`, `labels`, `graphLabels`, `t`) match its definition in `package-detail.tsx`. ✓

**Note on the broken-link fix:** flow-card `href` uses `flow.id`, which equals `flows.flowRefId` (the key `getFlowPackageDetail` resolves) per `lib/packages/attach.ts:667` using manifest `flowIds` as `flowRefId` — so the new links resolve where the old Flows-tab links did not. Step 5 verifies live.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-project-packages-tab-consolidation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
