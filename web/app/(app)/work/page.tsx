import type { WorkTableLabels } from "@/components/work/work-table";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { WorkTable } from "@/components/work/work-table";
import { buildWorkRowsLabels } from "@/lib/work/work-row-labels";
import { requireActiveSession } from "@/lib/authz";
import { getWorkTable } from "@/lib/queries/work-table";
import {
  filterWorkTableRows,
  groupWorkTableRows,
  normalizeWorkTableFilters,
} from "@/lib/work/work-table-view";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("work");

  return { title: t("title") };
}

export default async function WorkPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const [params, t, tStage, locale] = await Promise.all([
    searchParams,
    getTranslations("work"),
    getTranslations("workStage"),
    getLocale(),
  ]);
  const filters = normalizeWorkTableFilters(params);
  const table = await getWorkTable({ id: user.id, role: user.role });
  const visible = filterWorkTableRows(table.rows, filters);
  const groups = groupWorkTableRows(visible, filters.groupBy);

  // Options come from the rows the reader can already see, so the dropdown can
  // never name a project they cannot reach (`STG-09`).
  const projectOptions = [
    ...new Map(
      table.rows.map((row) => [
        row.projectSlug,
        { slug: row.projectSlug, name: row.projectName },
      ]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const labels: WorkTableLabels = {
    // Row labels come from the shared builder the Desk also calls, so a new
    // column cannot reach one surface and miss the other.
    ...buildWorkRowsLabels(t, tStage),
    rowCount: t("rowCount"),
    filters: {
      project: t("filters.project"),
      allProjects: t("filters.allProjects"),
      stage: t("filters.stage"),
      allStages: t("filters.allStages"),
      group: t("filters.group"),
      apply: t("filters.apply"),
    },
    empty: {
      noProjects: t("empty.noProjects"),
      noRows: t("empty.noRows"),
    },
    savedViews: {
      label: t("savedViews.label"),
      save: t("savedViews.save"),
      namePlaceholder: t("savedViews.namePlaceholder"),
      remove: t("savedViews.remove"),
      empty: t("savedViews.empty"),
    },
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
            {t("eyebrow")}
          </div>
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[720px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <WorkTable
        filters={filters}
        groups={groups}
        hasProjects={table.projectCount > 0}
        labels={labels}
        locale={locale}
        now={new Date()}
        projectOptions={projectOptions}
        totalRows={visible.length}
      />
    </div>
  );
}
