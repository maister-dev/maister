"use client";

import type { ReactNode, MouseEvent } from "react";
import type { RunPeekChildPage } from "@/lib/runs/peek-types";
import type { RunPeekView } from "@/lib/runs/run-query-state";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useTranslations } from "next-intl";

import { useLibrarian } from "@/components/librarian/librarian-provider";
import { RunChildrenProvider } from "@/components/runs/run-children-provider";
import { RunWorkbenchStreamProvider } from "@/components/runs/run-workbench-stream-provider";
import { buildRunPeekHref, readRunPeekQuery } from "@/lib/runs/run-query-state";

type PeekSelection = {
  selected: string;
  view: RunPeekView | null;
  node: string | null;
};
type PeekVisit = PeekSelection & { token: string; previous: string | null };
type PeekVisits = { entries: PeekVisit[]; active: string | null };
const visitKey = "maisterRunPeek";

function initialVisits(
  selection: ReturnType<typeof readRunPeekQuery>,
): PeekVisits {
  return selection.selected
    ? {
        entries: [
          {
            ...selection,
            selected: selection.selected,
            token: "initial",
            previous: null,
          },
        ],
        active: "initial",
      }
    : { entries: [], active: null };
}
type PeekContext = {
  anchor: string;
  selected: string | null;
  view: RunPeekView | null;
  node: string | null;
  canPrevious: boolean;
  ready: boolean;
  select: (id: string, trigger?: HTMLElement) => void;
  close: () => void;
  previous: () => void;
  setView: (view: RunPeekView) => void;
  setNode: (node: string | null) => void;
  href: (id: string) => string;
  t: ReturnType<typeof useTranslations<"runPeek">>;
};
const selectedIdSchema = z.string().uuid();
const Context = createContext<PeekContext | null>(null);
const subscribeReady = (): (() => void) => () => {};
const clientReady = (): boolean => true;
const serverReady = (): boolean => false;

export function useRunPeek(): PeekContext | null {
  return useContext(Context);
}

export function RunPeekController({
  anchorRunId,
  initialChildPage,
  children,
}: {
  anchorRunId: string;
  initialChildPage: RunPeekChildPage;
  children: ReactNode;
}): ReactNode {
  const pathname = usePathname();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const search = useSearchParams();
  const currentSearch = useSyncExternalStore(
    (notify) => {
      window.addEventListener("popstate", notify);
      window.addEventListener("maister:peek-history", notify);

      return () => {
        window.removeEventListener("popstate", notify);
        window.removeEventListener("maister:peek-history", notify);
      };
    },
    () => window.location.search,
    () => search.toString(),
  );
  const query = readRunPeekQuery(currentSearch);
  const t = useTranslations("runPeek");
  const [visits, setVisits] = useState<PeekVisits>(() => initialVisits(query));
  const visitsRef = useRef(visits);

  useEffect(() => {
    visitsRef.current = visits;
  }, [visits]);
  const opener = useRef<HTMLElement | null>(null);
  const openerIdentity = useRef<{ id: string; surface: string } | null>(null);
  const wasOpen = useRef(false);
  const restoreScroll = useRef<{ x: number; y: number } | null>(null);
  const parentExtent = useRef<{
    element: HTMLElement;
    previous: string;
    height: number;
  } | null>(null);
  const retainParentExtent = useCallback((): void => {
    const retained = parentExtent.current;

    if (retained) {
      retained.element.style.minHeight = `${retained.height}px`;

      return;
    }
    const element = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="run-shell-body"]',
      ),
    ].find((item) => item.getClientRects().length > 0);

    if (!element) return;
    const bounds = element.getBoundingClientRect();
    // Reserve the original scroll extent, including the page's lower spacing,
    // so hiding a tall inspector cannot clamp scroll or push sticky peek out of view.
    const height = Math.ceil(
      Math.max(
        bounds.height,
        document.documentElement.scrollHeight - bounds.top - window.scrollY,
      ),
    );

    parentExtent.current = {
      element,
      previous: element.style.minHeight,
      height,
    };
    element.style.minHeight = `${height}px`;
  }, []);

  useLayoutEffect(() => {
    if (query.selected !== null) retainParentExtent();
    else if (parentExtent.current) {
      parentExtent.current.element.style.minHeight =
        parentExtent.current.previous;
      parentExtent.current = null;
    }
  }, [query.selected !== null, retainParentExtent]);
  useLayoutEffect(
    () => () => {
      const retained = parentExtent.current;

      if (retained) retained.element.style.minHeight = retained.previous;
    },
    [],
  );
  useEffect(() => {
    const retain = (): void => {
      if (readRunPeekQuery(window.location.search).selected !== null)
        retainParentExtent();
    };

    window.addEventListener("popstate", retain, true);

    return () => window.removeEventListener("popstate", retain, true);
  }, [retainParentExtent]);
  const librarian = useLibrarian();
  const write = useCallback(
    (
      selected: string | null,
      view: RunPeekView | null = null,
      node: string | null = null,
      token: string | null = null,
    ): void => {
      const href = buildRunPeekHref(pathname, window.location.search, {
        selected,
        view,
        node,
      });

      // Next copies its framework state; forwarding private flags bypasses URL restoration.
      const state = {
        [visitKey]: { anchor: anchorRunId, token },
      };
      const address = href + window.location.hash;

      window.history.pushState(state, "", address);
      window.dispatchEvent(new Event("maister:peek-history"));
    },
    [pathname, anchorRunId],
  );
  const close = useCallback(() => {
    restoreScroll.current = { x: window.scrollX, y: window.scrollY };
    write(null);
    setVisits((current) => ({ ...current, active: null }));
  }, [write]);
  const select = useCallback(
    (id: string, trigger?: HTMLElement): void => {
      if (id === anchorRunId) {
        close();

        return;
      }
      if (query.selected === id) return;
      if (query.selected === null) {
        retainParentExtent();
        restoreScroll.current = { x: window.scrollX, y: window.scrollY };
        opener.current = trigger ?? (document.activeElement as HTMLElement);
        const surface = opener.current
          ?.closest('[data-testid="run-inspector-child-runs"]')
          ?.getAttribute("data-testid");

        openerIdentity.current = surface ? { id, surface } : null;
      }
      const token = crypto.randomUUID();
      const prior = visits.entries.find(
        (visit) => visit.token === visits.active,
      );
      const entries = visits.entries.map((visit) =>
        visit.token === visits.active && query.selected
          ? { ...visit, ...query, selected: query.selected }
          : visit,
      );
      const visit: PeekVisit = {
        selected: id,
        view: null,
        node: null,
        token,
        previous: query.selected ? (prior?.token ?? null) : null,
      };

      setVisits({ entries: [...entries, visit].slice(-32), active: token });
      write(id, null, null, token);
    },
    [anchorRunId, query.selected, query.view, query.node, visits, close, write],
  );
  const previous = useCallback(() => {
    const current = visits.entries.find(
      (visit) => visit.token === visits.active,
    );
    const prior = visits.entries.find(
      (visit) => visit.token === current?.previous,
    );

    if (!prior) return;
    setVisits({ ...visits, active: prior.token });
    write(prior.selected, prior.view, prior.node, prior.token);
  }, [visits, write]);
  const replaceSelection = useCallback(
    (selection: PeekSelection): void => {
      const current = visits.entries.find(
        (visit) => visit.token === visits.active,
      );
      const token = current?.token ?? crypto.randomUUID();
      const visit: PeekVisit = {
        ...selection,
        token,
        previous: current?.previous ?? null,
      };

      setVisits({
        entries: current
          ? visits.entries.map((entry) =>
              entry.token === token ? visit : entry,
            )
          : [...visits.entries, visit].slice(-32),
        active: token,
      });
      const href = buildRunPeekHref(
        pathname,
        window.location.search,
        selection,
      );

      window.history.replaceState(
        { [visitKey]: { anchor: anchorRunId, token } },
        "",
        href + window.location.hash,
      );
      window.dispatchEvent(new Event("maister:peek-history"));
    },
    [visits, anchorRunId, pathname],
  );

  useEffect(() => {
    const restore = (): void => {
      const selection = readRunPeekQuery(window.location.search);
      const saved: { anchor?: string; token?: string | null } | undefined =
        window.history.state?.[visitKey];
      const current = visitsRef.current;
      const visit =
        saved?.anchor === anchorRunId
          ? current.entries.find(
              (entry) =>
                entry.token === saved.token &&
                entry.selected === selection.selected,
            )
          : undefined;

      if (visit) setVisits({ ...current, active: visit.token });
      else if (selection.selected === null)
        setVisits({ ...current, active: null });
      else setVisits(initialVisits(selection));
    };

    window.addEventListener("popstate", restore);

    return () => window.removeEventListener("popstate", restore);
  }, [anchorRunId]);

  // A server refresh can replace custom history metadata. Restore only this
  // controller's current visit, using the public adapter and without adding a visit.
  useLayoutEffect(() => {
    const saved: { anchor?: string; token?: string | null } | undefined =
      window.history.state?.[visitKey];

    if (
      saved?.anchor === anchorRunId &&
      visits.entries.some((entry) => entry.token === saved.token)
    )
      return;
    const current = visits.entries.find(
      (entry) => entry.token === visits.active,
    );

    if (
      !current ||
      current.selected !== query.selected ||
      current.view !== query.view ||
      current.node !== query.node
    )
      return;
    window.history.replaceState(
      { [visitKey]: { anchor: anchorRunId, token: current.token } },
      "",
      window.location.href,
    );
  });

  useLayoutEffect(() => {
    const saved = restoreScroll.current;

    if (!saved) return;
    restoreScroll.current = null;
    window.scrollTo(saved.x, saved.y);
    const frame = requestAnimationFrame(() =>
      window.scrollTo(saved.x, saved.y),
    );

    return () => cancelAnimationFrame(frame);
  }, [query.selected !== null]);
  const suspend = librarian?.suspendForPeek;

  useEffect(
    () => (query.selected !== null ? suspend?.(close) : undefined),
    [query.selected !== null, suspend, close],
  );
  useEffect(() => {
    if (query.selected !== null) {
      wasOpen.current = true;

      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    requestAnimationFrame(() => {
      const original = opener.current;
      const identity = openerIdentity.current;
      const target = original?.isConnected
        ? original
        : identity
          ? document.querySelector<HTMLElement>(
              `[data-testid="${identity.surface}"] [data-peek-trigger="${CSS.escape(identity.id)}"]`,
            )
          : null;

      if (target?.isConnected && target.getClientRects().length) {
        target.focus({ preventScroll: true });

        return;
      }
      const heading = document.querySelector<HTMLElement>(
        '[data-testid="run-shell"] h1',
      );

      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
  }, [query.selected]);
  const value = useMemo<PeekContext>(
    () => ({
      anchor: anchorRunId,
      ready,
      ...query,
      canPrevious: visits.entries.some(
        (entry) =>
          entry.token ===
          visits.entries.find((visit) => visit.token === visits.active)
            ?.previous,
      ),
      select,
      close,
      previous,
      setView: (view) => {
        if (query.selected)
          replaceSelection({
            selected: query.selected,
            view,
            node: query.node,
          });
      },
      setNode: (node) => {
        if (query.selected)
          replaceSelection({
            selected: query.selected,
            view: query.view,
            node,
          });
      },
      href: (id) =>
        buildRunPeekHref(pathname, currentSearch, {
          selected: id,
          view: null,
          node: null,
        }),
      t,
    }),
    [
      anchorRunId,
      ready,
      query.selected,
      query.view,
      query.node,
      visits,
      select,
      close,
      previous,
      replaceSelection,
      write,
      pathname,
      currentSearch,
      t,
    ],
  );

  return (
    <Context.Provider value={value}>
      <RunWorkbenchStreamProvider
        anchorRunId={anchorRunId}
        selectedRunId={
          selectedIdSchema.safeParse(query.selected).success
            ? query.selected
            : null
        }
      >
        <RunChildrenProvider
          anchorRunId={anchorRunId}
          initialPage={initialChildPage}
        >
          {children}
        </RunChildrenProvider>
      </RunWorkbenchStreamProvider>
    </Context.Provider>
  );
}

export function RunPeekLink({
  runId,
  children,
  className,
}: {
  runId: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  const peek = useRunPeek();
  const click = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      !peek ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    peek.select(runId, event.currentTarget);
  };

  return (
    <a
      aria-current={peek?.selected === runId ? "page" : undefined}
      className={className}
      data-peek-trigger={runId}
      href={peek?.href(runId) ?? `/runs/${runId}`}
      onClick={click}
    >
      {children}
    </a>
  );
}
