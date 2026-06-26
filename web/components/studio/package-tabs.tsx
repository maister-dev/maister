import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

import { NumberedPagination } from "@/components/navigation/numbered-pagination";

// Tab bar + per-tab paged cards grid for the package detail (T1.3). Pure
// presentational Server Component: the page resolves the active tab + page slice
// from `searchParams` and passes the slice as already-rendered `cards`, so tab +
// page state lives ENTIRELY in the URL (`?tab=`, `?page=`) and survives
// refresh/back-forward. A tab with count 0 is omitted, never rendered empty.

export const PACKAGE_TAB_PAGE_SIZE = 12;

export interface PackageTabDescriptor {
  id: string;
  label: string;
  count: number;
}

export interface PackageTabsLabels {
  loadMore: string;
  next: string;
  page: string;
  paginationLabel: string;
  previous: string;
  showingCount: string;
  tabEmpty: string;
}

export interface PackageTabsProps {
  tabs: PackageTabDescriptor[];
  activeTab: string;
  page: number;
  totalForActive: number;
  pageSize: number;
  cards: ReactNode;
  layout?: "grid" | "stack";
  // Builds the href for a given (tab, page). Page 1 omits `?page=` for clean URLs.
  hrefFor: (tab: string, page: number) => string;
  labels: PackageTabsLabels;
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}

export function PackageTabs({
  tabs,
  activeTab,
  page,
  totalForActive,
  pageSize,
  cards,
  layout = "grid",
  hrefFor,
  labels,
}: PackageTabsProps): ReactElement {
  const visibleTabs = tabs.filter((tab) => tab.count > 0);

  if (visibleTabs.length === 0) {
    return (
      <p
        className="rounded-[14px] border border-dashed border-line bg-paper px-5 py-8 text-center text-[13px] text-mute"
        data-testid="package-tabs-empty"
      >
        {labels.tabEmpty}
      </p>
    );
  }

  const pageCount = Math.max(1, Math.ceil(totalForActive / pageSize));
  const shownThrough = Math.min(page * pageSize, totalForActive);

  return (
    <div className="flex flex-col gap-4" data-testid="package-tabs">
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2"
        role="tablist"
      >
        {visibleTabs.map((tab) => {
          const isActive = tab.id === activeTab;

          return (
            <Link
              key={tab.id}
              aria-current={isActive ? "page" : undefined}
              aria-selected={isActive}
              className={
                isActive
                  ? "rounded-[10px] border border-amber-line bg-amber-soft px-3 py-1.5 text-[12.5px] font-semibold text-ink"
                  : "rounded-[10px] border border-transparent px-3 py-1.5 text-[12.5px] font-semibold text-mute transition-colors hover:text-ink"
              }
              data-testid={`package-tab-${tab.id}`}
              href={hrefFor(tab.id, 1)}
              role="tab"
            >
              {tab.label}
              <span className="ml-1.5 font-mono text-[11px] text-mute">
                {tab.count}
              </span>
            </Link>
          );
        })}
      </div>

      <div
        className={
          layout === "stack"
            ? "flex flex-col gap-3"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        }
        data-testid="package-tab-cards"
      >
        {cards}
      </div>

      {pageCount > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-mute">
            {formatTemplate(labels.showingCount, {
              shown: shownThrough,
              total: totalForActive,
            })}
          </span>
          <NumberedPagination
            className="ml-auto"
            currentPage={page}
            hrefForPage={(pageNumber) => hrefFor(activeTab, pageNumber)}
            labels={{
              ariaLabel: labels.paginationLabel,
              next: labels.next,
              page: labels.page,
              previous: labels.previous,
            }}
            pageCount={pageCount}
            surface="inline"
          />
        </div>
      ) : null}
    </div>
  );
}
