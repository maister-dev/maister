"use client";

import type { ReactNode } from "react";
import type { TranscriptPage } from "@/lib/runs/transcript-page";
import type { TranscriptLabels } from "@/components/run-transcript/transcript-view";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import { TranscriptView } from "@/components/run-transcript/transcript-view";
import { useRunPageStream } from "@/components/runs/run-stream-provider";

class TranscriptReadFailure extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

type Direction = "earlier" | "later";
type ContiguousEarlier = { boundaryId: string; page: TranscriptPage };
type History = {
  pages: TranscriptPage[];
  newerAvailable: boolean;
  liveUpdate?: boolean;
};
type ReadError = {
  failure: TranscriptReadFailure;
  direction: Direction | "refresh" | "latest";
};
type ScrollAnchor = { id: string; top: number; scroller: HTMLElement };
const MAX_PAGES = 5;
const MAX_RETAINED_RECORDS = MAX_PAGES * 100;
const MAX_PORTION_BYTES = 380 * 1024;
const MAX_RETAINED_BYTES = MAX_PAGES * MAX_PORTION_BYTES + 1024;
const NEAR_EDGE_PX = 240;
const BOTTOM_PX = 64;

async function fetchTranscriptPage(
  runId: string,
  nodeId: string | null,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<TranscriptPage> {
  const params = new URLSearchParams(query);

  if (nodeId) params.set("node", nodeId);
  params.set("limit", "100");
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/transcript?${params}`,
    { signal },
  );

  if (!response.ok) {
    const body: { reason?: string } = await response.json();

    throw new TranscriptReadFailure(
      response.status,
      body.reason ?? "read_failed",
    );
  }

  return response.json() as Promise<TranscriptPage>;
}

function retainedQuery(page: TranscriptPage): URLSearchParams | null {
  return page.window.before && page.window.after
    ? new URLSearchParams({
        windowBefore: page.window.before,
        windowAfter: page.window.after,
      })
    : null;
}

/** Refresh a contiguous observed range while retaining its unreturned prefix and suffix. */
function mergeRefresh(
  page: TranscriptPage,
  refreshed: TranscriptPage,
): TranscriptPage {
  const updates = new Map(
    refreshed.messages.map((message) => [message.id, message]),
  );
  const indexes = new Map(
    page.messages.map((message, index) => [message.id, index]),
  );
  const matches = refreshed.messages.flatMap((message, freshIndex) => {
    const cachedIndex = indexes.get(message.id);

    return cachedIndex === undefined ? [] : [{ freshIndex, cachedIndex }];
  });
  const cachedIndexes = matches.map(({ cachedIndex }) => cachedIndex);
  const first = matches[0],
    last = matches.at(-1);
  const messages =
    first && last
      ? [
          ...page.messages.slice(0, Math.min(...cachedIndexes)),
          ...refreshed.messages,
          ...page.messages.slice(Math.max(...cachedIndexes) + 1),
        ].map((message) => updates.get(message.id) ?? message)
      : page.messages;
  const sameFirst = messages[0]?.id === refreshed.messages[0]?.id;
  const sameLast = messages.at(-1)?.id === refreshed.messages.at(-1)?.id;

  return {
    ...page,
    usage: refreshed.usage,
    projection: refreshed.projection,
    messages,
    beforeCursor: sameFirst ? refreshed.beforeCursor : page.beforeCursor,
    hasEarlier: sameFirst ? refreshed.hasEarlier : page.hasEarlier,
    afterCursor: sameLast ? refreshed.afterCursor : page.afterCursor,
    hasLater: sameLast ? refreshed.hasLater : page.hasLater,
    window: {
      before: sameFirst ? refreshed.window.before : page.window.before,
      after: sameLast ? refreshed.window.after : page.window.after,
    },
  };
}

/** Consolidate overlapping windows so late records between wire portions stay visible. */
function mergeRefreshedWindows(
  pages: TranscriptPage[],
  refreshed: TranscriptPage,
): TranscriptPage[] {
  const refreshedIds = new Set(refreshed.messages.map((message) => message.id));
  const overlapping = pages.flatMap((page, index) =>
    page.messages.some((message) => refreshedIds.has(message.id))
      ? [index]
      : [],
  );

  if (!overlapping.length) return pages;
  const start = Math.min(...overlapping),
    finish = Math.max(...overlapping);
  const first = pages[start],
    last = pages[finish];
  const messages = new Map(
    pages
      .slice(start, finish + 1)
      .flatMap((page) =>
        page.messages.map((message) => [message.id, message] as const),
      ),
  );
  const combined: TranscriptPage = {
    ...last,
    messages: [...messages.values()],
    beforeCursor: first.beforeCursor,
    hasEarlier: first.hasEarlier,
    window: { before: first.window.before, after: last.window.after },
  };

  return [
    ...pages.slice(0, start),
    mergeRefresh(combined, refreshed),
    ...pages.slice(finish + 1),
  ];
}

function retainedRecordCount(pages: TranscriptPage[]): number {
  return new Set(
    pages.flatMap((page) => page.messages.map((message) => message.id)),
  ).size;
}

/** Extend the existing tail before allocating another retained portion. */
function appendPortion(
  pages: TranscriptPage[],
  appended: TranscriptPage,
): TranscriptPage[] {
  const last = pages.at(-1);

  if (!appended.messages.length) return pages;
  if (!last) return [appended];
  const byId = new Map(
    [...last.messages, ...appended.messages].map((message) => [
      message.id,
      message,
    ]),
  );
  const merged: TranscriptPage = {
    ...appended,
    messages: [...byId.values()],
    beforeCursor: last.beforeCursor,
    hasEarlier: last.hasEarlier,
    window: { before: last.window.before, after: appended.window.after },
  };

  return merged.messages.length <= 100 &&
    new TextEncoder().encode(JSON.stringify(merged)).byteLength <=
      MAX_PORTION_BYTES
    ? [...pages.slice(0, -1), merged]
    : [...pages, appended];
}

export function RunTranscriptHistory({
  runId,
  nodeId,
  live = true,
  labels: suppliedLabels,
}: {
  runId: string;
  nodeId: string | null;
  live?: boolean;
  labels?: TranscriptLabels;
}): ReactNode {
  const t = useTranslations("runPeek"),
    runT = useTranslations("run");
  const stream = useRunPageStream(runId, live);
  const [history, setHistory] = useState<History>({
    pages: [],
    newerAvailable: false,
  });
  const historyRef = useRef(history);
  const [error, setError] = useState<ReadError | null>(null);
  const errorRef = useRef<ReadError | null>(null);
  const [loading, setLoading] = useState<Direction | "latest" | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [notice, setNotice] = useState<
    "attemptChanged" | "historyBound" | null
  >(null);
  const host = useRef<HTMLDivElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const navigation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  const previousAttempt = useRef<string | null | undefined>(undefined);
  const following = useRef(true);
  const liveCatchup = useRef(false);
  const latestObserved = useRef<TranscriptPage["messages"][number] | undefined>(
    undefined,
  );
  const positioned = useRef(false);
  const scrollPosition = useRef(0);
  const pendingAnchor = useRef<ScrollAnchor | null>(null);
  const pendingBottom = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const navigateRef = useRef<(direction: Direction) => void>(() => {});
  const jumpRef = useRef<() => void>(() => {});
  const seenBoundaries = useRef(new Set<string>());
  const activeWindow = useRef<string | null>(null);

  const publish = useCallback((next: History): void => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const publishError = useCallback((next: ReadError | null): void => {
    errorRef.current = next;
    setError(next);
  }, []);
  const scrollOwner = useCallback((): HTMLElement | null => {
    const nested = host.current?.closest<HTMLElement>(
      '[data-testid="run-peek-scroll"]',
    );
    const owner = nested ?? document.scrollingElement;

    return owner instanceof HTMLElement ? owner : null;
  }, []);
  const viewport = useCallback((): { top: number; bottom: number } => {
    const nested = host.current?.closest<HTMLElement>(
      '[data-testid="run-peek-scroll"]',
    );
    const bounds = nested?.getBoundingClientRect();

    return {
      top: Math.max(0, bounds?.top ?? 0),
      bottom: Math.min(
        window.innerHeight,
        bounds?.bottom ?? window.innerHeight,
      ),
    };
  }, []);
  const maybeLoadEarlier = useCallback((): boolean => {
    if (
      !positioned.current ||
      !controller.current ||
      controller.current.signal.aborted ||
      errorRef.current ||
      navigation.current ||
      pendingAnchor.current ||
      pendingBottom.current
    )
      return false;
    const bounds = viewport();
    const tailBounds = end.current?.getBoundingClientRect();
    const firstMessage = host.current?.querySelector<HTMLElement>(
      "[data-transcript-message-id]",
    );
    const firstTop = firstMessage?.getBoundingClientRect().top;
    const atEnd =
      tailBounds !== undefined &&
      tailBounds.bottom <= bounds.bottom + BOTTOM_PX &&
      tailBounds.bottom >= bounds.top;

    if (
      atEnd ||
      firstTop === undefined ||
      firstTop < bounds.top - NEAR_EDGE_PX ||
      firstTop > bounds.bottom ||
      !historyRef.current.pages[0]?.hasEarlier
    )
      return false;
    navigateRef.current("earlier");

    return true;
  }, [viewport]);
  const retainScroll = useCallback((): void => {
    const owner = scrollOwner();
    const bounds = viewport();
    const element = [
      ...(host.current?.querySelectorAll<HTMLElement>(
        "[data-transcript-message-id]",
      ) ?? []),
    ].find(
      (item) =>
        item.getBoundingClientRect().bottom > bounds.top &&
        item.getBoundingClientRect().top < bounds.bottom,
    );
    const id = element?.dataset.transcriptMessageId;

    if (owner && element && id)
      pendingAnchor.current = {
        id,
        top: element.getBoundingClientRect().top,
        scroller: owner,
      };
  }, [scrollOwner, viewport]);
  const boundPages = useCallback(
    async (
      pages: TranscriptPage[],
      signal: AbortSignal,
      preceding: ContiguousEarlier | null,
    ): Promise<TranscriptPage[] | null> => {
      if (
        new TextEncoder().encode(JSON.stringify(pages)).byteLength <=
          MAX_RETAINED_BYTES &&
        retainedRecordCount(pages) <= MAX_RETAINED_RECORDS &&
        pages.length <= MAX_PAGES
      )
        return pages;
      const view = viewport();
      const anchor =
        [
          ...(host.current?.querySelectorAll<HTMLElement>(
            "[data-transcript-message-id]",
          ) ?? []),
        ].find(
          (item) =>
            item.getBoundingClientRect().bottom > view.top &&
            item.getBoundingClientRect().top < view.bottom,
        )?.dataset.transcriptMessageId ?? pages.at(-1)?.messages[0]?.id;

      if (!anchor) return pages;
      const centered = await fetchTranscriptPage(
        runId,
        nodeId,
        new URLSearchParams({ anchor }),
        signal,
      );

      if (centered.attemptId !== pages[0]?.attemptId)
        throw new TranscriptReadFailure(409, "transcript_attempt_changed");

      const earlier =
        centered.hasEarlier && centered.beforeCursor
          ? preceding?.boundaryId === centered.messages[0]?.id
            ? preceding.page
            : await fetchTranscriptPage(
                runId,
                nodeId,
                new URLSearchParams({ before: centered.beforeCursor }),
                signal,
              )
          : null;

      if (earlier && earlier.attemptId !== centered.attemptId)
        throw new TranscriptReadFailure(409, "transcript_attempt_changed");
      const recentered = [
        ...(earlier?.messages.length ? [earlier] : []),
        centered,
      ];
      const currentView = viewport();
      const currentAnchor = [
        ...(host.current?.querySelectorAll<HTMLElement>(
          "[data-transcript-message-id]",
        ) ?? []),
      ].find(
        (item) =>
          item.getBoundingClientRect().bottom > currentView.top &&
          item.getBoundingClientRect().top < currentView.bottom,
      )?.dataset.transcriptMessageId;

      // A reader may move while this bounded recenter request is in flight.
      // Keep the displayed cache if the replacement would remove their anchor.
      if (
        currentAnchor &&
        !recentered.some((page) =>
          page.messages.some((message) => message.id === currentAnchor),
        )
      )
        return null;

      return recentered;
    },
    [runId, nodeId, viewport],
  );
  const releaseNavigation = useCallback((): void => {
    navigation.current?.abort();
    navigation.current = null;
    setLoading(null);
  }, []);
  const adoptFailure = useCallback(
    (failure: unknown, direction: ReadError["direction"]): void => {
      const next =
        failure instanceof TranscriptReadFailure
          ? failure
          : new TranscriptReadFailure(503, "transport");

      retainScroll();
      publishError({ failure: next, direction });
      if (next.status === 403 || next.status === 404) {
        controller.current?.abort();
        releaseNavigation();
        generation.current++;
        revision.current++;
        publish({ pages: [], newerAvailable: false });
      }
    },
    [publish, publishError, releaseNavigation, retainScroll],
  );

  useEffect(() => {
    const abort = new AbortController();
    const ownedGeneration = ++generation.current;
    let inflight = false,
      dirty = false;

    controller.current = abort;
    const valid = (): boolean =>
      !abort.signal.aborted && generation.current === ownedGeneration;

    async function refresh(): Promise<void> {
      if (inflight) {
        dirty = true;

        return;
      }
      // Failed refreshes and latest jumps require an explicit retry.
      if (
        errorRef.current?.direction === "refresh" ||
        errorRef.current?.direction === "latest"
      )
        return;
      inflight = true;
      const ownedRevision = revision.current;

      try {
        const latest = await fetchTranscriptPage(
          runId,
          nodeId,
          new URLSearchParams(),
          abort.signal,
        );

        if (!valid()) return;
        if (ownedRevision !== revision.current) {
          dirty = true;

          return;
        }
        const attemptChanged =
          previousAttempt.current !== undefined &&
          previousAttempt.current !== latest.attemptId;

        previousAttempt.current = latest.attemptId;
        const cached = historyRef.current;

        if (!cached.pages.length || attemptChanged) {
          if (attemptChanged) {
            revision.current++;
            releaseNavigation();
            setNotice("attemptChanged");
          }
          seenBoundaries.current.clear();
          following.current = true;
          liveCatchup.current = false;
          setReadingEarlier(false);
          pendingBottom.current = true;
          latestObserved.current = latest.messages.at(-1);
          publish({ pages: [latest], newerAvailable: false });
          publishError(null);

          return;
        }
        // Refresh only the visible retained portion; every response remains bounded.
        const visibleIds = new Set(
          [
            ...(host.current?.querySelectorAll<HTMLElement>(
              "[data-transcript-message-id]",
            ) ?? []),
          ]
            .filter((item) => {
              const bounds = item.getBoundingClientRect();
              const view = viewport();

              return bounds.bottom >= view.top && bounds.top <= view.bottom;
            })
            .map((item) => item.dataset.transcriptMessageId),
        );
        const visibleIndex = cached.pages.findIndex((page) =>
          page.messages.some((message) => visibleIds.has(message.id)),
        );
        const selectedIndex =
          visibleIndex < 0 ? cached.pages.length - 1 : visibleIndex;
        const selected = cached.pages[selectedIndex];
        const visibleAnchor = visibleIds.values().next().value;
        const query = visibleAnchor
          ? new URLSearchParams({ anchor: visibleAnchor })
          : retainedQuery(selected);
        const refreshed = query
          ? await fetchTranscriptPage(runId, nodeId, query, abort.signal).catch(
              async (failure: unknown) => {
                if (
                  nodeId &&
                  failure instanceof TranscriptReadFailure &&
                  failure.reason === "invalid_anchor"
                ) {
                  // The current attempt can change between the latest and anchored reads.
                  const current = await fetchTranscriptPage(
                    runId,
                    nodeId,
                    new URLSearchParams(),
                    abort.signal,
                  );

                  if (current.attemptId !== latest.attemptId)
                    throw new TranscriptReadFailure(
                      409,
                      "transcript_attempt_changed",
                    );
                }
                throw failure;
              },
            )
          : null;

        if (!valid()) return;
        if (ownedRevision !== revision.current) {
          dirty = true;

          return;
        }
        const latestById = new Map(
          latest.messages.map((message) => [message.id, message]),
        );
        const overlaid = cached.pages.map((page) => ({
          ...page,
          messages: page.messages.map(
            (message) => latestById.get(message.id) ?? message,
          ),
        }));
        const latestSharesTail =
          latest.messages.at(-1)?.id ===
          cached.pages.at(-1)?.messages.at(-1)?.id;
        const withLatestRange = latestSharesTail
          ? mergeRefreshedWindows(overlaid, latest)
          : overlaid;
        let pages = refreshed
          ? mergeRefreshedWindows(withLatestRange, refreshed)
          : withLatestRange;
        const last = pages.at(-1)!;
        const latestEnd = latest.messages.at(-1)?.id;
        const retainedIds = new Set(
          pages.flatMap((page) => page.messages.map((message) => message.id)),
        );
        const hasNewer = latestEnd !== undefined && !retainedIds.has(latestEnd);
        const retainedMessages = new Map(
          cached.pages.flatMap((page) =>
            page.messages.map((message) => [message.id, message] as const),
          ),
        );
        const observedMessages = new Map(
          [...latest.messages, ...(refreshed?.messages ?? [])].map(
            (message) => [message.id, message],
          ),
        );
        const contentChanged = [...observedMessages.values()].some(
          (message) =>
            retainedMessages.get(message.id)?.content !== message.content,
        );
        const lastObserved = latestObserved.current;
        const latestMessage = latest.messages.at(-1);
        const liveUpdate =
          !following.current &&
          (cached.liveUpdate === true ||
            (latestMessage !== undefined &&
              lastObserved !== undefined &&
              (lastObserved.id !== latestMessage.id ||
                lastObserved.content !== latestMessage.content)) ||
            [...observedMessages.values()].some(
              (message) =>
                retainedMessages.has(message.id) &&
                retainedMessages.get(message.id)?.content !== message.content,
            ));
        const unseen =
          !following.current &&
          (cached.newerAvailable || hasNewer || contentChanged);

        if (hasNewer && !cached.pages.at(-1)!.hasLater)
          liveCatchup.current = true;
        if (!hasNewer) liveCatchup.current = false;
        // Retained pages are contiguous. Fetch after their boundary instead of
        // attaching a disjoint latest page when a live burst exceeds one portion.
        if (
          (following.current || liveCatchup.current) &&
          hasNewer &&
          last.afterCursor
        ) {
          const appended = await fetchTranscriptPage(
            runId,
            nodeId,
            new URLSearchParams({ after: last.afterCursor }),
            abort.signal,
          );

          if (!valid()) return;
          if (ownedRevision !== revision.current) {
            dirty = true;

            return;
          }
          if (appended.attemptId !== latest.attemptId) {
            dirty = true;

            return;
          }
          pages = appendPortion(pages, appended);
          if (pages.length > MAX_PAGES) {
            seenBoundaries.current.clear();
            const view = viewport();
            const visibleNow = new Set(
              [
                ...(host.current?.querySelectorAll<HTMLElement>(
                  "[data-transcript-message-id]",
                ) ?? []),
              ]
                .filter(
                  (item) =>
                    item.getBoundingClientRect().bottom > view.top &&
                    item.getBoundingClientRect().top < view.bottom,
                )
                .map((item) => item.dataset.transcriptMessageId),
            );
            const firstVisible = pages[0].messages.some((message) =>
              visibleNow.has(message.id),
            );

            if (!following.current && firstVisible) {
              pages.pop();
              liveCatchup.current = false;
              pages[pages.length - 1] = { ...pages.at(-1)!, hasLater: true };
            } else pages.shift();
          }
          const stillNewer =
            latestEnd !== undefined &&
            !pages.some((page) =>
              page.messages.some((message) => message.id === latestEnd),
            );

          const bounded = await boundPages(pages, abort.signal, null);

          if (!valid()) return;
          if (!bounded) {
            dirty = true;

            return;
          }
          if (ownedRevision !== revision.current) {
            dirty = true;

            return;
          }
          if (following.current) {
            pendingAnchor.current = null;
            pendingBottom.current = true;
          } else retainScroll();
          if (bounded !== pages) {
            seenBoundaries.current.clear();
            setNotice("historyBound");
          }
          latestObserved.current = latestMessage;
          publish({
            pages: bounded,
            liveUpdate,
            newerAvailable:
              !following.current || stillNewer || bounded.at(-1)!.hasLater,
          });
          const appendedEnd = appended.messages.at(-1)?.id;
          const retainedEnd = bounded.at(-1)?.messages.at(-1)?.id;

          if (appendedEnd && retainedEnd !== appendedEnd)
            liveCatchup.current = false;
          if (stillNewer && (following.current || liveCatchup.current))
            dirty = true;
          if (!stillNewer) liveCatchup.current = false;
        } else {
          const updated = [...pages];
          const final = updated.at(-1)!;

          updated[updated.length - 1] = {
            ...final,
            usage: latest.usage,
            projection: latest.projection,
            hasLater: hasNewer,
          };
          const bounded = await boundPages(updated, abort.signal, null);

          if (!valid()) return;
          if (!bounded) {
            dirty = true;

            return;
          }
          if (ownedRevision !== revision.current) {
            dirty = true;

            return;
          }
          if (following.current) {
            pendingAnchor.current = null;
            pendingBottom.current = true;
          } else retainScroll();
          if (bounded !== updated) {
            seenBoundaries.current.clear();
            setNotice("historyBound");
          }
          latestObserved.current = latestMessage;
          publish({
            pages: bounded,
            liveUpdate,
            newerAvailable: unseen || bounded.at(-1)!.hasLater,
          });
        }
      } catch (failure) {
        if (!valid()) return;
        if (ownedRevision !== revision.current) {
          dirty = true;

          return;
        }
        if (
          failure instanceof TranscriptReadFailure &&
          failure.reason === "transcript_attempt_changed"
        ) {
          revision.current++;
          releaseNavigation();
          previousAttempt.current = undefined;
          publish({ pages: [], newerAvailable: false });
          setNotice("attemptChanged");
          dirty = true;
        } else adoptFailure(failure, "refresh");
      } finally {
        inflight = false;
        if (dirty && valid() && !errorRef.current) {
          dirty = false;
          void refresh();
        }
      }
    }
    refreshRef.current = () => {
      void refresh();
    };
    void refresh();

    return () => {
      abort.abort();
      controller.current = null;
      releaseNavigation();
    };
  }, [
    runId,
    nodeId,
    adoptFailure,
    publish,
    publishError,
    releaseNavigation,
    retainScroll,
    viewport,
    retryKey,
    boundPages,
  ]);

  useEffect(() => {
    if (stream.eventCount > 0) refreshRef.current();
  }, [stream.eventCount]);

  const navigate = useCallback(
    async (direction: Direction): Promise<void> => {
      const cached = historyRef.current;
      const boundary =
        direction === "earlier" ? cached.pages[0] : cached.pages.at(-1);
      const cursor =
        direction === "earlier"
          ? boundary?.beforeCursor
          : boundary?.afterCursor;
      const available =
        direction === "earlier" ? boundary?.hasEarlier : boundary?.hasLater;
      const parent = controller.current?.signal;
      const key = `${direction}:${cursor}`;

      if (
        !available ||
        !cursor ||
        !parent ||
        parent.aborted ||
        navigation.current ||
        seenBoundaries.current.has(key)
      )
        return;
      const owned = new AbortController();
      const abortNavigation = (): void => owned.abort();
      const ownedRevision = ++revision.current;

      parent.addEventListener("abort", abortNavigation, { once: true });
      navigation.current = owned;
      retainScroll();
      following.current = false;
      setReadingEarlier(true);
      setLoading(direction);
      publishError(null);
      try {
        const page = await fetchTranscriptPage(
          runId,
          nodeId,
          new URLSearchParams({
            [direction === "earlier" ? "before" : "after"]: cursor,
          }),
          owned.signal,
        );

        if (owned.signal.aborted || ownedRevision !== revision.current) return;
        if (page.attemptId !== previousAttempt.current)
          throw new TranscriptReadFailure(409, "transcript_attempt_changed");
        const current = historyRef.current;
        const pages =
          direction === "earlier"
            ? [page, ...current.pages]
            : [...current.pages, page];
        let evicted = false;
        const view = viewport();
        const visibleAnchor = [
          ...(host.current?.querySelectorAll<HTMLElement>(
            "[data-transcript-message-id]",
          ) ?? []),
        ].find(
          (item) =>
            item.getBoundingClientRect().bottom > view.top &&
            item.getBoundingClientRect().top < view.bottom,
        )?.dataset.transcriptMessageId;

        // A refreshed logical window can span several wire portions. Never
        // evict its visible anchor while pruning the far end of the cache.
        while (
          pages.length > 1 &&
          (pages.length > MAX_PAGES ||
            new TextEncoder().encode(JSON.stringify(pages)).byteLength >
              MAX_RETAINED_BYTES ||
            retainedRecordCount(pages) > MAX_RETAINED_RECORDS)
        ) {
          const candidate = direction === "earlier" ? pages.at(-1)! : pages[0];

          if (
            visibleAnchor &&
            candidate.messages.some((message) => message.id === visibleAnchor)
          )
            break;
          if (direction === "earlier") {
            liveCatchup.current = false;
            pages.pop();
          } else pages.shift();
          evicted = true;
        }
        if (direction === "earlier" && pages.at(-1))
          pages[pages.length - 1] = {
            ...pages.at(-1)!,
            hasLater: evicted || pages.at(-1)!.hasLater,
          };
        if (direction === "later" && pages[0])
          pages[0] = {
            ...pages[0],
            hasEarlier: evicted || pages[0].hasEarlier,
          };
        const bounded = await boundPages(
          pages,
          owned.signal,
          direction === "earlier" && boundary?.messages[0]
            ? { boundaryId: boundary.messages[0].id, page }
            : null,
        );

        if (!bounded) {
          retainScroll();

          return;
        }
        if (owned.signal.aborted || ownedRevision !== revision.current) return;
        retainScroll();
        if (bounded !== pages || evicted) setNotice("historyBound");
        if (bounded !== pages) liveCatchup.current = false;
        seenBoundaries.current.add(key);
        // Evicted windows remain reachable from either direction.
        if (evicted || bounded !== pages) seenBoundaries.current.clear();
        revision.current++;
        publish({
          pages: bounded,
          liveUpdate: current.liveUpdate,
          newerAvailable:
            direction === "earlier"
              ? current.newerAvailable || evicted || bounded.at(-1)!.hasLater
              : bounded.at(-1)!.hasLater,
        });
      } catch (failure) {
        if (!owned.signal.aborted && ownedRevision === revision.current) {
          if (
            failure instanceof TranscriptReadFailure &&
            failure.reason === "transcript_attempt_changed"
          ) {
            setNotice("attemptChanged");
            refreshRef.current();
          } else adoptFailure(failure, direction);
        }
      } finally {
        parent.removeEventListener("abort", abortNavigation);
        if (navigation.current === owned) {
          navigation.current = null;
          setLoading(null);
        }
      }
    },
    [
      runId,
      nodeId,
      adoptFailure,
      publish,
      publishError,
      retainScroll,
      boundPages,
      viewport,
    ],
  );

  useLayoutEffect(() => {
    navigateRef.current = (direction) => {
      void navigate(direction);
    };
  }, [navigate]);

  const jumpToLatest = useCallback(async (): Promise<void> => {
    const parent = controller.current?.signal;

    if (!parent || parent.aborted) return;
    releaseNavigation();
    const owned = new AbortController();
    const abortNavigation = (): void => owned.abort();
    const ownedRevision = ++revision.current;

    parent.addEventListener("abort", abortNavigation, { once: true });
    navigation.current = owned;
    retainScroll();
    setLoading("latest");
    publishError(null);
    try {
      const latest = await fetchTranscriptPage(
        runId,
        nodeId,
        new URLSearchParams(),
        owned.signal,
      );

      if (owned.signal.aborted || ownedRevision !== revision.current) return;
      previousAttempt.current = latest.attemptId;
      following.current = true;
      liveCatchup.current = false;
      setReadingEarlier(false);
      seenBoundaries.current.clear();
      pendingAnchor.current = null;
      pendingBottom.current = true;
      setNotice(null);
      revision.current++;
      latestObserved.current = latest.messages.at(-1);
      publish({ pages: [latest], newerAvailable: false });
    } catch (failure) {
      if (!owned.signal.aborted && ownedRevision === revision.current)
        adoptFailure(failure, "latest");
    } finally {
      parent.removeEventListener("abort", abortNavigation);
      if (navigation.current === owned) {
        navigation.current = null;
        setLoading(null);
      }
    }
  }, [
    runId,
    nodeId,
    adoptFailure,
    publish,
    publishError,
    releaseNavigation,
    retainScroll,
  ]);

  useLayoutEffect(() => {
    jumpRef.current = () => {
      void jumpToLatest();
    };
  }, [jumpToLatest]);

  useLayoutEffect(() => {
    const owner = scrollOwner();

    const nested = host.current?.closest<HTMLElement>(
      '[data-testid="run-peek-scroll"]',
    );

    // An unstuck peek can extend below the viewport. Reserve enough trailing
    // space to align its tail within the visible part without scrolling the page.
    if (host.current)
      host.current.style.paddingBottom = nested
        ? `${Math.max(0, nested.getBoundingClientRect().bottom - window.innerHeight)}px`
        : "";
    if (pendingBottom.current && owner && end.current) {
      const bounds = viewport();

      owner.scrollTop +=
        end.current.getBoundingClientRect().bottom - bounds.bottom;
      positioned.current = true;
    } else if (pendingAnchor.current && owner) {
      const saved = pendingAnchor.current;
      const element = [
        ...(host.current?.querySelectorAll<HTMLElement>(
          "[data-transcript-message-id]",
        ) ?? []),
      ].find((item) => item.dataset.transcriptMessageId === saved.id);

      if (element)
        owner.scrollTop += element.getBoundingClientRect().top - saved.top;
    }
    if (owner && (pendingBottom.current || pendingAnchor.current))
      scrollPosition.current = owner.scrollTop;
    pendingBottom.current = false;
    pendingAnchor.current = null;
    // Native scroll events can coalesce with a refresh's anchor restoration.
    // Recheck the same edge after layout releases its scroll ownership.
    queueMicrotask(maybeLoadEarlier);
  }, [
    history,
    error,
    loading,
    readingEarlier,
    notice,
    scrollOwner,
    viewport,
    maybeLoadEarlier,
  ]);

  useEffect(() => {
    const owner = scrollOwner();
    const nested = host.current?.closest('[data-testid="run-peek-scroll"]');
    const target = nested ? owner : window;

    scrollPosition.current = owner?.scrollTop ?? 0;

    if (!owner || !target) return;
    const onScroll = (): void => {
      const top = owner.scrollTop;
      const delta = top - scrollPosition.current;

      scrollPosition.current = top;
      if (
        !positioned.current ||
        pendingAnchor.current ||
        pendingBottom.current ||
        navigation.current
      )
        return;
      const bounds = viewport();
      const cached = historyRef.current;
      const last = cached.pages.at(-1);
      const atEnd =
        !!end.current &&
        end.current.getBoundingClientRect().bottom <=
          bounds.bottom + BOTTOM_PX &&
        end.current.getBoundingClientRect().bottom >= bounds.top;
      const hasLater = !!last?.hasLater;
      const atLatest = atEnd && !hasLater;

      if (maybeLoadEarlier()) return;
      // Controlled scrolls synchronize this position in the layout phase.
      // Their delayed native scroll event must not turn off live following.
      if (Math.abs(delta) < 1) return;

      const wasFollowing = following.current;

      following.current = atLatest;
      if (wasFollowing !== atLatest) {
        retainScroll();
        setReadingEarlier(!atLatest);
      }
      if (atLatest && cached.newerAvailable) {
        retainScroll();
        publish({ ...cached, newerAvailable: false, liveUpdate: false });
      }
      const visible = [
        ...(host.current?.querySelectorAll<HTMLElement>(
          "[data-transcript-message-id]",
        ) ?? []),
      ].find((item) => item.getBoundingClientRect().bottom > bounds.top);
      const visibleId = visible?.dataset.transcriptMessageId;
      const visiblePage = cached.pages.find((page) =>
        page.messages.some((message) => message.id === visibleId),
      );
      const visibleKey = visiblePage?.window.before ?? null;

      if (visibleKey && visibleKey !== activeWindow.current) {
        activeWindow.current = visibleKey;
        refreshRef.current();
      }
      if (errorRef.current) return;

      if (
        delta > 0 &&
        end.current &&
        end.current.getBoundingClientRect().bottom <=
          bounds.bottom + NEAR_EDGE_PX &&
        end.current.getBoundingClientRect().bottom >= bounds.top &&
        hasLater
      )
        navigateRef.current("later");
    };

    const onViewportChange = (): void => {
      if (nested instanceof HTMLElement && host.current)
        host.current.style.paddingBottom = `${Math.max(0, nested.getBoundingClientRect().bottom - window.innerHeight)}px`;
      if (following.current && positioned.current && end.current) {
        owner.scrollTop +=
          end.current.getBoundingClientRect().bottom - viewport().bottom;
        scrollPosition.current = owner.scrollTop;
      }
    };

    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onViewportChange);
    if (nested)
      window.addEventListener("scroll", onViewportChange, { passive: true });

    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onViewportChange);
      if (nested) window.removeEventListener("scroll", onViewportChange);
    };
  }, [scrollOwner, viewport, retainScroll, publish, maybeLoadEarlier]);

  const pages = history.pages;
  const first = pages[0],
    last = pages.at(-1);
  const byId = new Map(
    pages.flatMap((page) =>
      page.messages.map((message) => [message.id, message] as const),
    ),
  );
  const seen = new Set<string>();
  const messages = pages.flatMap((page) =>
    page.messages
      .filter((message) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);

        return true;
      })
      .map((message) => byId.get(message.id)!),
  );
  const labels: TranscriptLabels = {
    ...(suppliedLabels ?? {
      thinking: runT("chatThinking"),
      rawEvent: runT("chatRawEvent"),
      input: runT("chatToolInput"),
      result: runT("chatToolResult"),
      copy: runT("chatCopy"),
      copied: runT("chatCopied"),
      toolCount: (name, count) => runT("chatToolCount", { name, count }),
    }),
    limitedPreview: (bytes) =>
      `${t("preview")} · ${t("previewBytes", { bytes })}`,
    fullContent: t("fullContent"),
  };
  const retry = (): void => {
    const failed = errorRef.current;

    retainScroll();
    publishError(null);
    if (failed?.direction === "earlier" || failed?.direction === "later")
      navigateRef.current(failed.direction);
    else if (failed?.direction === "latest") jumpRef.current();
    else if (controller.current?.signal.aborted)
      setRetryKey((value) => value + 1);
    else refreshRef.current();
  };

  const controlClass =
    "rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium text-ink hover:border-amber focus-visible:outline-amber disabled:opacity-60";
  const updateLabel = history.liveUpdate
    ? t("newerMessages")
    : history.newerAvailable
      ? t("laterAvailable")
      : null;

  return (
    <div
      ref={host}
      className="min-w-0 space-y-3 [overflow-anchor:none]"
      data-testid="run-transcript-history"
    >
      {error ? (
        <p role="status">
          {t(
            error.failure.reason === "transcript_projection_poisoned"
              ? "projectionPoisoned"
              : error.failure.status === 403
                ? "forbidden"
                : error.failure.status === 404
                  ? "unavailable"
                  : "error",
          )}{" "}
          <button className={controlClass} type="button" onClick={retry}>
            {t(
              error.direction === "earlier"
                ? "retryEarlier"
                : error.direction === "later"
                  ? "retryLater"
                  : "retry",
            )}
          </button>
        </p>
      ) : null}
      {notice ? <p role="status">{t(notice)}</p> : null}
      {!pages.length && !error ? (
        <p role="status">{t("loadingTranscript")}</p>
      ) : null}
      {first?.hasEarlier ? (
        <button
          className={controlClass}
          data-testid="transcript-earlier"
          disabled={loading !== null}
          type="button"
          onClick={() => navigateRef.current("earlier")}
        >
          {t("earlierMessages")}
        </button>
      ) : null}
      {loading ? (
        <p data-testid="transcript-history-loading" role="status">
          {t(
            loading === "earlier"
              ? "loadingEarlier"
              : loading === "later"
                ? "loadingLater"
                : "loadingTranscript",
          )}
        </p>
      ) : null}
      {last?.projection.state === "pending" ? (
        <p role="status">{t("projectionPending")}</p>
      ) : null}
      {last?.usage ? (
        <p>
          {t("usage")}: {last.usage.used} / {last.usage.size}
        </p>
      ) : null}
      {last?.projection.state === "caught_up" && messages.length === 0 ? (
        <p>{t("emptyTranscript")}</p>
      ) : null}
      <TranscriptView
        labels={labels}
        messages={messages}
        running={live && stream.liveness === "live"}
      />
      {readingEarlier || updateLabel ? (
        <div className="pointer-events-none sticky bottom-12 z-10 flex h-0 min-w-0 justify-end">
          <div className="pointer-events-auto flex -translate-y-full items-center gap-2 rounded-md bg-paper p-1">
            {updateLabel ? (
              <span className="sr-only" role="status">
                {updateLabel}
              </span>
            ) : null}
            <button
              className={controlClass}
              data-new-messages={history.liveUpdate ? "true" : undefined}
              data-testid="transcript-jump-latest"
              disabled={loading === "latest"}
              title={updateLabel ?? undefined}
              type="button"
              onClick={() => jumpRef.current()}
            >
              {t("latestMessages")}
              {history.liveUpdate ? (
                <span
                  aria-hidden="true"
                  className="ml-2 inline-block h-2 w-2 rounded-full bg-amber"
                />
              ) : null}
            </button>
          </div>
        </div>
      ) : null}
      <div ref={end} data-testid="transcript-tail" />
      {last?.hasLater ? (
        <button
          className={controlClass}
          data-testid="transcript-later"
          disabled={loading !== null}
          type="button"
          onClick={() => navigateRef.current("later")}
        >
          {t("laterMessages")}
        </button>
      ) : null}
    </div>
  );
}
