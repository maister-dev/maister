"use client";

import type { ReactNode } from "react";
import type { RunPeekChildPage } from "@/lib/runs/peek-types";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";

type Entry = {
  page: RunPeekChildPage | null;
  loading: boolean;
  error: number | null;
};
type ChildrenContext = {
  anchor: string;
  entries: ReadonlyMap<string, Entry>;
  retain: (parent: string, cursor: string | null) => () => void;
  reload: (parent: string, cursor: string | null) => void;
};
const Context = createContext<ChildrenContext | null>(null);
const cacheKey = (parent: string, cursor: string | null): string =>
  `${parent}:${cursor ?? ""}`;

/** At most eight 25-entry pages, with only mounted slices revalidated by ticks. */
export function RunChildrenProvider({
  anchorRunId,
  initialPage,
  children,
}: {
  anchorRunId: string;
  initialPage: RunPeekChildPage;
  children: ReactNode;
}): ReactNode {
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(
    () =>
      new Map([
        [
          cacheKey(anchorRunId, null),
          { page: initialPage, loading: false, error: null },
        ],
      ]),
  );
  const cache = useRef(new Map(entries));
  const owners = useRef(
    new Map<
      string,
      { parent: string; cursor: string | null; count: number; version: number }
    >(),
  );
  const pending = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  const treeTick = useWorkbenchStream()?.treeTick ?? 0;
  const loadRef = useRef<
    (parent: string, cursor: string | null) => Promise<void>
  >(async () => {});
  const publish = useCallback((key: string, entry: Entry): void => {
    cache.current.delete(key);
    cache.current.set(key, entry);
    while (cache.current.size > 8) {
      const oldest = cache.current.keys().next().value;

      if (oldest === undefined) break;
      cache.current.delete(oldest);
    }
    if (alive.current) setEntries(new Map(cache.current));
  }, []);
  const load = useCallback(
    async (parent: string, cursor: string | null): Promise<void> => {
      const key = cacheKey(parent, cursor);

      if (pending.current.has(key)) return;
      const controller = new AbortController();

      pending.current.set(key, controller);
      const version = owners.current.get(key)?.version ?? 0;

      publish(key, {
        page: cache.current.get(key)?.page ?? null,
        loading: true,
        error: null,
      });
      try {
        const query = new URLSearchParams({ parent, limit: "25" });

        if (cursor) query.set("cursor", cursor);
        const response = await fetch(
          `/api/runs/${anchorRunId}/children?${query}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          publish(key, { page: null, loading: false, error: response.status });

          return;
        }
        const page: RunPeekChildPage = await response.json();

        if (
          !controller.signal.aborted &&
          page.anchorRunId === anchorRunId &&
          page.parentRunId === parent
        )
          publish(key, { page, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          publish(key, {
            page: null,
            loading: false,
            error: error instanceof TypeError ? 503 : 500,
          });
      } finally {
        pending.current.delete(key);
        if (
          alive.current &&
          (owners.current.get(key)?.version ?? version) !== version
        )
          void loadRef.current(parent, cursor);
      }
    },
    [anchorRunId, publish],
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const retain = useCallback(
    (parent: string, cursor: string | null): (() => void) => {
      const key = cacheKey(parent, cursor);
      const previous = owners.current.get(key);

      owners.current.set(key, {
        parent,
        cursor,
        count: (previous?.count ?? 0) + 1,
        version: previous?.version ?? 0,
      });
      if (!cache.current.has(key)) void load(parent, cursor);

      return () => {
        const entry = owners.current.get(key);

        if (!entry) return;
        if (entry.count <= 1) owners.current.delete(key);
        else owners.current.set(key, { ...entry, count: entry.count - 1 });
      };
    },
    [load],
  );
  const reload = useCallback(
    (parent: string, cursor: string | null): void => {
      const entry = owners.current.get(cacheKey(parent, cursor));

      if (entry) entry.version++;
      void load(parent, cursor);
    },
    [load],
  );

  useEffect(() => {
    if (treeTick === 0) return;
    for (const entry of owners.current.values())
      reload(entry.parent, entry.cursor);
  }, [treeTick, reload]);
  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      for (const controller of pending.current.values()) controller.abort();
      pending.current.clear();
    };
  }, []);
  const value = useMemo(
    () => ({ anchor: anchorRunId, entries, retain, reload }),
    [anchorRunId, entries, retain, reload],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useRunChildren(
  parent: string,
  cursor: string | null = null,
): {
  page: RunPeekChildPage | null;
  loading: boolean;
  error: number | null;
  reload: () => void;
} | null {
  const context = useContext(Context);
  const retain = context?.retain;

  useEffect(() => retain?.(parent, cursor), [retain, parent, cursor]);
  if (!context) return null;

  return {
    ...(context.entries.get(cacheKey(parent, cursor)) ?? {
      page: null,
      loading: true,
      error: null,
    }),
    reload: () => context.reload(parent, cursor),
  };
}
