"use client";

import type {
  ObservatoryCurrent,
  ObservatoryHrefPatch,
} from "@/lib/observatory/href";
import type { ReactElement, ReactNode } from "react";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { buildObservatoryHref } from "@/lib/observatory/href";

/**
 * The filter edits that have been committed but have not come back yet
 * (ADR-177 D7).
 *
 * `current` is a SERVER value: it only changes when a round-trip lands. Anything
 * that builds a URL from it alone — a second control, or a view tab whose
 * `<Link>` href the server rendered — builds it from a state the reader has
 * already moved on from, and silently drops what they did in between. Clicking
 * a period preset and then a view tab lost the period; the tab's href predated
 * the preset by construction.
 *
 * So the patch lives ABOVE both the bar and the tabs. It is held as state, not
 * only as a ref, because the tab hrefs have to re-render once it changes — a
 * ref would keep the bar correct and leave the tabs exactly as wrong as before.
 * The ref mirror exists for the other half: two commits inside one tick must
 * compose, and `useState` has not applied the first yet when the second runs.
 */
interface ObservatoryFilterStateValue {
  /** Committed, not yet reflected by a server render. */
  pending: ObservatoryHrefPatch;
  /** Merge `patch` in; returns the composed patch to navigate with. */
  commit: (patch: ObservatoryHrefPatch) => ObservatoryHrefPatch;
}

// No default value. A permissive one would let a surface that forgot the
// provider keep working while silently dropping every composed edit — the same
// shape of invisible degradation this whole change removes. A missing provider
// is a wiring mistake and says so at the first render.
const ObservatoryFilterStateContext =
  createContext<ObservatoryFilterStateValue | null>(null);

export function useObservatoryFilterState(): ObservatoryFilterStateValue {
  const value = useContext(ObservatoryFilterStateContext);

  if (value === null) {
    throw new Error(
      "Observatory filter controls must render inside <ObservatoryFilterState>",
    );
  }

  return value;
}

export function ObservatoryFilterState({
  children,
  current,
  pathname,
}: {
  children: ReactNode;
  current: ObservatoryCurrent;
  pathname: string;
}): ReactElement {
  const [pending, setPending] = useState<ObservatoryHrefPatch>({});
  const pendingRef = useRef<ObservatoryHrefPatch>({});
  // The URL this server state represents. Its changing is the ONLY evidence a
  // navigation landed: a transition whose scope schedules no state update
  // settles before the page it asked for arrives, so `isPending` is not.
  const currentHref = buildObservatoryHref(pathname, current);

  useEffect(() => {
    // Either the patch arrived, or the reader went somewhere else entirely
    // (Back, a heatmap drill-down). Both spend it — replaying it onto the next
    // edit would re-impose a filter the URL no longer carries. Returning the
    // same reference when there is nothing to clear keeps React from
    // re-rendering the tabs on every landing.
    pendingRef.current = {};
    setPending((previous) =>
      Object.keys(previous).length === 0 ? previous : {},
    );
  }, [currentHref]);

  const commit = (patch: ObservatoryHrefPatch): ObservatoryHrefPatch => {
    const merged = { ...pendingRef.current, ...patch };

    pendingRef.current = merged;
    setPending(merged);

    return merged;
  };

  return (
    <ObservatoryFilterStateContext.Provider value={{ pending, commit }}>
      {children}
    </ObservatoryFilterStateContext.Provider>
  );
}
