"use client";

import type { UseRunStreamResult } from "@/lib/use-run-stream";
import type { RunStreamLifecycleKind } from "@/lib/run-stream-controller";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { reconnectDelayMs } from "@/lib/run-stream-controller";
import { peekFrameSchema } from "@/lib/runs/peek-stream-contract";
import {
  isDocumentHidden,
  subscribeDocumentVisibility,
} from "@/lib/sse-visibility";

type WorkbenchState = {
  anchor: string;
  selection: string | null;
  mainTick: number;
  mainSummaryTick: number;
  mainExecutionTick: number;
  childTick: number;
  treeTick: number;
  liveness: RunStreamLifecycleKind;
  error: string | null;
  unavailable: boolean;
};

export type WorkbenchStream = {
  main: UseRunStreamResult;
  child: UseRunStreamResult;
  treeTick: number;
  mainSummaryTick: number;
  mainExecutionTick: number;
  selectionUnavailable: boolean;
};

function initialWorkbenchState(
  anchor: string,
  selection: string | null,
): WorkbenchState {
  return {
    anchor,
    selection,
    mainTick: 0,
    mainSummaryTick: 0,
    mainExecutionTick: 0,
    childTick: 0,
    treeTick: 0,
    liveness: "connecting",
    error: null,
    unavailable: false,
  };
}

/** A single physical channel feeds two identity-isolated tick-only contexts. */
export function useRunWorkbenchStream(
  anchor: string,
  selected: string | null,
): WorkbenchStream {
  const [prevChannel, setPrevChannel] = useState({ anchor, selected });
  const [state, setState] = useState<WorkbenchState>(() =>
    initialWorkbenchState(anchor, selected),
  );
  const [connection, setConnection] = useState(0);
  const attempts = useRef(0);
  const active = useRef<EventSource | null>(null);
  const channelRef = useRef({ anchor, selected });

  if (prevChannel.anchor !== anchor || prevChannel.selected !== selected) {
    setPrevChannel({ anchor, selected });
    setState((current) =>
      current.anchor !== anchor
        ? initialWorkbenchState(anchor, selected)
        : {
            ...current,
            selection: selected,
            childTick: 0,
            unavailable: false,
            liveness: "connecting",
            error: null,
          },
    );
  }

  const reconnect = useCallback(() => {
    attempts.current = 0;
    setState((current) => ({
      ...current,
      liveness: "connecting",
      error: null,
    }));
    setConnection((value) => value + 1);
  }, []);

  useEffect(() => {
    if (
      channelRef.current.anchor !== anchor ||
      channelRef.current.selected !== selected
    ) {
      channelRef.current = { anchor, selected };
      attempts.current = 0;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const closeActive = (): void => {
      const current = active.current;

      active.current = null;
      current?.close();
    };

    const connect = (): void => {
      if (disposed || active.current !== null || isDocumentHidden()) return;
      clearTimer();

      const es = new EventSource(
        `/api/runs/${encodeURIComponent(anchor)}/peek/stream${selected ? `?selected=${encodeURIComponent(selected)}` : ""}`,
      );

      active.current = es;
      const isCurrent = (): boolean => !disposed && active.current === es;
      const fail = (error: string): void => {
        if (!isCurrent()) return;
        if (isDocumentHidden()) {
          clearTimer();
          closeActive();
          attempts.current = 0;

          return;
        }
        closeActive();
        const delay = reconnectDelayMs(attempts.current++);

        setState((value) => ({
          ...value,
          liveness: delay === null ? "disconnected" : "reconnecting",
          error,
        }));
        if (delay !== null) {
          timer = setTimeout(() => {
            timer = null;
            if (disposed || isDocumentHidden()) return;
            setState((value) => ({
              ...value,
              liveness: "connecting",
              error: null,
            }));
            connect();
          }, delay);
        }
      };

      es.onmessage = (event) => {
        if (!isCurrent()) return;
        let raw: unknown;

        try {
          raw = JSON.parse(event.data);
        } catch {
          fail("peek_protocol");

          return;
        }
        const parsed = peekFrameSchema.safeParse(raw);

        if (!parsed.success) {
          fail("peek_protocol");

          return;
        }
        const frame = parsed.data;

        if (frame.type === "peek.ready") {
          if (
            frame.anchorRunId !== anchor ||
            (frame.selectionState === "ready" &&
              frame.selectedRunId !== selected)
          ) {
            fail("peek_identity");

            return;
          }
          attempts.current = 0;
          setState((value) => ({
            ...value,
            selection: selected,
            mainTick: value.mainTick + 1,
            mainSummaryTick: value.mainSummaryTick + 1,
            childTick: value.childTick + 1,
            treeTick: value.treeTick + 1,
            liveness: "live",
            error: null,
            unavailable: frame.selectionState === "unavailable",
          }));
        } else if (frame.type === "run.changed") {
          if (frame.runId !== anchor && frame.runId !== selected) {
            fail("peek_identity");

            return;
          }
          attempts.current = 0;
          setState((value) => ({
            ...value,
            mainTick: value.mainTick + (frame.runId === anchor ? 1 : 0),
            mainSummaryTick:
              value.mainSummaryTick +
              (frame.runId === anchor && frame.kind === "summary" ? 1 : 0),
            mainExecutionTick:
              value.mainExecutionTick +
              (frame.runId === anchor && frame.kind === "execution" ? 1 : 0),
            childTick: value.childTick + (frame.runId === selected ? 1 : 0),
          }));
        } else if (frame.type === "peek.changed") {
          setState((value) => ({ ...value, treeTick: value.treeTick + 1 }));
        } else if (frame.type === "peek.selection_unavailable") {
          setState((value) => ({
            ...value,
            unavailable: true,
            childTick: value.childTick + 1,
          }));
        } else {
          setState((value) => ({
            ...value,
            mainTick: value.mainTick + 1,
            childTick: value.childTick + 1,
            treeTick: value.treeTick + 1,
          }));
          fail("peek_resync");
        }
      };
      es.onerror = () => fail("peek_transport");
    };

    connect();
    const unsubscribeVisibility = subscribeDocumentVisibility({
      onHide: () => {
        if (disposed) return;
        clearTimer();
        closeActive();
        attempts.current = 0;
      },
      onShow: () => {
        if (disposed || active.current !== null) return;
        attempts.current = 0;
        setState((value) => ({
          ...value,
          liveness: "connecting",
          error: null,
        }));
        connect();
      },
    });

    return () => {
      disposed = true;
      unsubscribeVisibility();
      clearTimer();
      closeActive();
    };
  }, [anchor, selected, connection]);

  return useMemo(() => {
    const shared = {
      events: [],
      status:
        state.liveness === "live"
          ? ("open" as const)
          : state.liveness === "connecting"
            ? ("connecting" as const)
            : ("closed" as const),
      liveness: state.liveness,
      lastEventId: null,
      error: state.error,
      reconnect,
    };

    return {
      main: { ...shared, eventCount: state.mainTick },
      child: {
        ...shared,
        eventCount: state.selection === selected ? state.childTick : 0,
      },
      treeTick: state.treeTick,
      mainSummaryTick: state.mainSummaryTick,
      mainExecutionTick: state.mainExecutionTick,
      selectionUnavailable: state.selection === selected && state.unavailable,
    };
  }, [state, selected, reconnect]);
}
