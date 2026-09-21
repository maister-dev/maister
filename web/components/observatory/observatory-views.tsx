"use client";

import type { ObservatoryLabels } from "@/components/observatory/types";
import type { ParsedObservatoryFilters } from "@/lib/observatory/filters";
import type { ReactElement } from "react";

import { Tabs, type TabItem } from "@/components/navigation/tabs";
import { useObservatoryFilterState } from "@/components/observatory/observatory-filter-state";
import { observatoryViewHref } from "@/lib/observatory/href";
import { OBSERVATORY_VIEWS } from "@/lib/observatory/views";

// ADR-177 D6: the view axis, as the shared `Tabs` primitive in href mode —
// URL state, so a view survives refresh and back/forward like every other
// tab bar in the app. `Tabs` takes no hooks of its own, so these stay real
// `<Link>`s (they PUSH, unlike the bar's filter commits) even though this
// component is now a client one.
//
// Client, because each href has to carry the filter edits that are still in
// flight; the server rendered `current` before them.

export interface ObservatoryViewsProps {
  current: ParsedObservatoryFilters["current"];
  labels: ObservatoryLabels;
  pathname: string;
}

export function ObservatoryViews({
  current,
  labels,
  pathname,
}: ObservatoryViewsProps): ReactElement {
  const { pending } = useObservatoryFilterState();
  const items: TabItem[] = OBSERVATORY_VIEWS.map((view) => ({
    key: view,
    label: labels.views[view],
    href: observatoryViewHref(pathname, current, view, pending),
    testId: `observatory-view-${view}`,
  }));

  return (
    <Tabs
      activeKey={current.view}
      ariaLabel={labels.views.label}
      className="mb-5"
      items={items}
    />
  );
}
