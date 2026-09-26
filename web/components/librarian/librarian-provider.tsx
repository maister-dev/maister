"use client";

import type { ReactElement, ReactNode } from "react";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type LibrarianIndicatorState =
  | "none"
  | "running"
  | "unread"
  | "action_required";

type LibrarianContextValue = {
  ownerId: string;
  open: boolean;
  indicator: LibrarianIndicatorState;
  /** Bumped on every durable change frame; the open panel refetches on it. */
  changeTick: number;
  hostComposerVisible: boolean;
  openPanel: (opener: HTMLElement | null) => void;
  closePanel: () => void;
  takeOpener: () => HTMLElement | null;
  setIndicator: (state: LibrarianIndicatorState) => void;
  registerHostComposer: () => () => void;
};

const LibrarianContext = createContext<LibrarianContextValue | null>(null);

export function useLibrarian(): LibrarianContextValue | null {
  return useContext(LibrarianContext);
}

/** ADR-189 D6: an assistant composer (scratch, Studio AI) registers while it
 * is visible, so the librarian opens only as the sheet beside it. Outside the
 * provider (tests, standalone renders) it does nothing. */
export function useLibrarianHostComposer(visible: boolean): void {
  const registerHostComposer =
    useContext(LibrarianContext)?.registerHostComposer;

  useEffect(() => {
    if (!visible || !registerHostComposer) return undefined;

    return registerHostComposer();
  }, [visible, registerHostComposer]);
}

const CHANGE_FRAMES = new Set([
  "librarian.message",
  "librarian.turn",
  "librarian.reset",
]);

function isIndicator(value: unknown): value is LibrarianIndicatorState {
  return (
    value === "none" ||
    value === "running" ||
    value === "unread" ||
    value === "action_required"
  );
}

/** ADR-189 D2/D3: one provider around the trigger and the panel, so a route
 * change never remounts either. It holds the librarian stream while the tab
 * is visible and resumes it from the last durable id when the tab returns. */
export function LibrarianProvider({
  ownerId,
  initialIndicator,
  children,
}: {
  ownerId: string;
  initialIndicator: LibrarianIndicatorState;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [indicator, setIndicator] =
    useState<LibrarianIndicatorState>(initialIndicator);
  const [changeTick, setChangeTick] = useState(0);
  const [hostComposers, setHostComposers] = useState(0);
  const openerRef = useRef<HTMLElement | null>(null);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined")
      return undefined;
    let source: EventSource | null = null;

    function connect(): void {
      if (source) return;
      const url = new URL("/api/librarian/stream", window.location.origin);

      if (lastEventIdRef.current)
        url.searchParams.set("lastEventId", lastEventIdRef.current);
      source = new EventSource(url.toString());
      source.onmessage = (message) => {
        if (/^(0|[1-9][0-9]*)$/.test(message.lastEventId))
          lastEventIdRef.current = message.lastEventId;
        let frame: { type?: unknown; state?: unknown };

        try {
          frame = JSON.parse(message.data) as typeof frame;
        } catch {
          return;
        }
        if (frame.type === "librarian.indicator" && isIndicator(frame.state))
          setIndicator(frame.state);
        if (typeof frame.type === "string" && CHANGE_FRAMES.has(frame.type))
          setChangeTick((tick) => tick + 1);
      };
    }

    function disconnect(): void {
      source?.close();
      source = null;
    }

    function onVisibility(): void {
      if (document.visibilityState === "visible") connect();
      else disconnect();
    }

    if (document.visibilityState !== "hidden") connect();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
    };
  }, []);

  const openPanel = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setOpen(true);
  }, []);
  const closePanel = useCallback(() => setOpen(false), []);
  const takeOpener = useCallback(() => {
    const opener = openerRef.current;

    openerRef.current = null;

    return opener;
  }, []);
  const registerHostComposer = useCallback(() => {
    setHostComposers((count) => count + 1);

    return () => setHostComposers((count) => Math.max(0, count - 1));
  }, []);

  const value = useMemo<LibrarianContextValue>(
    () => ({
      ownerId,
      open,
      indicator,
      changeTick,
      hostComposerVisible: hostComposers > 0,
      openPanel,
      closePanel,
      takeOpener,
      setIndicator,
      registerHostComposer,
    }),
    [
      ownerId,
      open,
      indicator,
      changeTick,
      hostComposers,
      openPanel,
      closePanel,
      takeOpener,
      registerHostComposer,
    ],
  );

  return (
    <LibrarianContext.Provider value={value}>
      {children}
    </LibrarianContext.Provider>
  );
}
