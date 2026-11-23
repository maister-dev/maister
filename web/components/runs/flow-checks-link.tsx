"use client";

import type { ReactElement } from "react";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { buildRunHref } from "@/lib/runs/run-query-state";

interface FlowChecksLinkProps {
  label: string;
  workbench: boolean;
  rowId?: string;
}

function focusCheck(
  shell: Element,
  workbench: boolean,
  rowId?: string,
): boolean {
  const selector =
    rowId && workbench
      ? '[data-testid="selected-result"]'
      : '[data-testid="flow-verification"]';
  const entry = shell.querySelector<HTMLElement>(selector);

  if (!entry || !entry.getClientRects().length) return false;
  if (rowId && workbench && entry.dataset.resultId !== `gate:${rowId}`)
    return false;
  if (entry instanceof HTMLDetailsElement) entry.open = true;
  const reason =
    rowId && !workbench
      ? entry.querySelector<HTMLElement>(
          `[data-check-row="${CSS.escape(`gate:${rowId}`)}"]`,
        )
      : null;

  (reason ?? entry.querySelector<HTMLElement>("summary") ?? entry).focus();

  return true;
}

export function FlowChecksLink({
  label,
  workbench,
  rowId,
}: FlowChecksLinkProps): ReactElement {
  const pathname = usePathname();
  const search = useSearchParams();
  const pending = useRef<Element | null>(null);
  const destination = new URLSearchParams(search.toString());
  if (workbench) {
    destination.delete("kind");
    destination.delete("state");
  }
  const href = buildRunHref(
    pathname,
    destination,
    workbench
      ? {
          wb: "evidence",
          evidenceItem: rowId ? `gate:${rowId}` : null,
          evidenceView: null,
        }
      : { inspector: "open" },
  );

  useEffect(() => {
    if (pending.current && focusCheck(pending.current, workbench, rowId))
      pending.current = null;
  }, [search, workbench, rowId]);

  return (
    <a
      className="text-sm underline"
      href={href}
      onClick={(event) => {
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        const shell = event.currentTarget.closest('[data-testid="run-shell"]');

        if (window.location.pathname + window.location.search !== href)
          window.history.pushState(null, "", href);
        if (shell && !focusCheck(shell, workbench, rowId))
          pending.current = shell;
      }}
    >
      {label}
    </a>
  );
}
