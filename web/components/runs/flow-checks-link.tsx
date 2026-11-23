"use client";

import type { ReactElement, ReactNode } from "react";

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
  checkId?: string,
): boolean {
  const selector =
    checkId && workbench
      ? '[data-testid="selected-result"]'
      : '[data-testid="flow-verification"]';
  const entry = shell.querySelector<HTMLElement>(selector);

  if (!entry || !entry.getClientRects().length) return false;
  if (checkId && workbench && entry.dataset.resultId !== checkId) return false;
  const reason =
    checkId && !workbench
      ? entry.querySelector<HTMLElement>(
          `[data-check-row="${CSS.escape(checkId)}"]`,
        )
      : null;

  if (checkId && !workbench && !reason) return false;
  if (entry instanceof HTMLDetailsElement) entry.open = true;
  (reason ?? entry.querySelector<HTMLElement>("summary") ?? entry).focus();

  return true;
}

export function InspectorFlowChecks({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const target = useSearchParams().get("inspectorCheck");

  useEffect(() => {
    if (panel.current && target) {
      focusCheck(
        panel.current,
        false,
        target === "summary" ? undefined : target,
      );
    }
  }, [target]);

  return <div ref={panel}>{children}</div>;
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
  const checkId = rowId ? `gate:${rowId}` : undefined;

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
          evidenceItem: checkId ?? null,
          evidenceView: null,
        }
      : {
          inspector: "open",
          inspectorCheck: checkId ?? "summary",
          evidenceItem: null,
        },
  );

  useEffect(() => {
    if (pending.current && focusCheck(pending.current, workbench, checkId))
      pending.current = null;
  }, [search, workbench, checkId]);

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

        const changing =
          window.location.pathname + window.location.search !== href;

        if (changing) window.history.pushState(null, "", href);
        if (
          shell &&
          (workbench || !changing) &&
          !focusCheck(shell, workbench, checkId)
        )
          pending.current = shell;
      }}
    >
      {label}
    </a>
  );
}
