import type { ReactElement } from "react";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import Link from "next/link";

export type NumberedPaginationItem = number | "ellipsis";

export interface NumberedPaginationLabels {
  ariaLabel: string;
  next: string;
  page: string;
  previous: string;
}

export interface NumberedPaginationProps {
  className?: string;
  currentPage: number;
  hrefForPage: (page: number) => string;
  labels: NumberedPaginationLabels;
  pageCount: number;
  surface?: "inline" | "panel";
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), pageCount);
}

export function buildNumberedPaginationItems({
  currentPage,
  pageCount,
}: {
  currentPage: number;
  pageCount: number;
}): NumberedPaginationItem[] {
  const normalizedPageCount = normalizePositiveInteger(pageCount, 1);
  const normalizedCurrentPage = clampPage(
    normalizePositiveInteger(currentPage, 1),
    normalizedPageCount,
  );

  if (normalizedPageCount <= 7) {
    return Array.from({ length: normalizedPageCount }, (_, index) => index + 1);
  }

  const pages = [
    1,
    normalizedCurrentPage - 1,
    normalizedCurrentPage,
    normalizedCurrentPage + 1,
    normalizedPageCount,
  ]
    .filter((page) => page >= 1 && page <= normalizedPageCount)
    .filter((page, index, list) => list.indexOf(page) === index)
    .sort((a, b) => a - b);

  return pages.flatMap((page, index) => {
    const previous = pages[index - 1];

    if (!previous || page - previous === 1) return [page];

    return ["ellipsis", page] as NumberedPaginationItem[];
  });
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}

function BoundaryControl({
  disabled,
  href,
  label,
  side,
}: {
  disabled: boolean;
  href: string;
  label: string;
  side: "next" | "previous";
}): ReactElement {
  const icon =
    side === "previous" ? (
      <ChevronLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
    ) : (
      <ChevronRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
    );
  const className =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-semibold text-ink-2 transition-colors";

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={clsx(className, "cursor-default opacity-45")}
      >
        {side === "previous" ? icon : null}
        {label}
        {side === "next" ? icon : null}
      </span>
    );
  }

  return (
    <Link
      className={clsx(className, "hover:border-mute hover:text-ink")}
      href={href}
    >
      {side === "previous" ? icon : null}
      {label}
      {side === "next" ? icon : null}
    </Link>
  );
}

export function NumberedPagination({
  className,
  currentPage,
  hrefForPage,
  labels,
  pageCount,
  surface = "panel",
}: NumberedPaginationProps): ReactElement | null {
  const normalizedPageCount = normalizePositiveInteger(pageCount, 1);

  if (normalizedPageCount <= 1) return null;

  const normalizedCurrentPage = clampPage(
    normalizePositiveInteger(currentPage, 1),
    normalizedPageCount,
  );
  const items = buildNumberedPaginationItems({
    currentPage: normalizedCurrentPage,
    pageCount: normalizedPageCount,
  });
  const surfaceClass =
    surface === "panel"
      ? "flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3"
      : "flex flex-wrap items-center gap-3";

  return (
    <nav
      aria-label={labels.ariaLabel}
      className={clsx(surfaceClass, className)}
      data-testid="numbered-pagination"
    >
      <BoundaryControl
        disabled={normalizedCurrentPage <= 1}
        href={hrefForPage(normalizedCurrentPage - 1)}
        label={labels.previous}
        side="previous"
      />

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {items.map((item, index) =>
          item === "ellipsis" ? (
            <span
              key={`ellipsis-${index}`}
              aria-hidden="true"
              className="px-1 font-mono text-[11px] text-mute"
            >
              ...
            </span>
          ) : (
            <Link
              key={item}
              aria-current={item === normalizedCurrentPage ? "page" : undefined}
              aria-label={formatTemplate(labels.page, { page: item })}
              className={
                item === normalizedCurrentPage
                  ? "rounded-[8px] border border-amber-line bg-amber-soft px-2.5 py-1 font-mono text-[11px] font-semibold text-ink"
                  : "rounded-[8px] border border-line bg-ivory px-2.5 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:border-amber hover:text-ink"
              }
              data-testid={`pagination-page-${item}`}
              href={hrefForPage(item)}
            >
              {item}
            </Link>
          ),
        )}
      </div>

      <BoundaryControl
        disabled={normalizedCurrentPage >= normalizedPageCount}
        href={hrefForPage(normalizedCurrentPage + 1)}
        label={labels.next}
        side="next"
      />
    </nav>
  );
}
