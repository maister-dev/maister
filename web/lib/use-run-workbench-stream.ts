"use client";

import type { UseRunStreamResult } from "@/lib/use-run-stream";
import type { RunStreamLifecycleKind } from "@/lib/run-stream-controller";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { reconnectDelayMs } from "@/lib/run-stream-controller";
import { peekFrameSchema } from "@/lib/runs/peek-stream-contract";

type WorkbenchState = {
  selection: string | null;
  mainTick: number;
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
  selectionUnavailable: boolean;
};

/** A single physical channel feeds two identity-isolated tick-only contexts. */
export function useRunWorkbenchStream(
  anchor: string,
  selected: string | null,
): WorkbenchStream {
  const [state, setState] = useState<WorkbenchState>({
    selection: selected,
    mainTick: 0,
    childTick: 0,
    treeTick: 0,
    liveness: "connecting",
    error: null,
    unavailable: false,
  });
  const [connection, setConnection] = useState(0);
  const attempts = useRef(0);
  const active = useRef<EventSource | null>(null);
  const reconnect = useCallback(() => {
    attempts.current = 0;
    setConnection((value) => value + 1);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const es = new EventSource(
      `/api/runs/${encodeURIComponent(anchor)}/peek/stream${selected ? `?selected=${encodeURIComponent(selected)}` : ""}`,
    );

    active.current = es;
    // The effect replaces an externally owned EventSource connection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => ({
      ...current,
      selection: selected,
      childTick: current.selection === selected ? current.childTick : 0,
      unavailable: false,
      liveness: "connecting",
      error: null,
    }));
    const current = (): boolean => !disposed && active.current === es;
    const fail = (error: string): void => {
      if (!current()) return;
      es.close();
      active.current = null;
      const delay = reconnectDelayMs(attempts.current++);

      setState((value) => ({
        ...value,
        liveness: delay === null ? "disconnected" : "reconnecting",
        error,
      }));
      if (delay !== null)
        timer = setTimeout(() => {
          if (!disposed) setConnection((value) => value + 1);
        }, delay);
    };

    es.onmessage = (event) => {
      if (!current()) return;
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
          (frame.selectionState === "ready" && frame.selectedRunId !== selected)
        ) {
          fail("peek_identity");

          return;
        }
        setState((value) => ({
          ...value,
          selection: selected,
          mainTick: value.mainTick + 1,
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
          childTick: value.childTick + (frame.runId === selected ? 1 : 0),
        }));
      } else if (frame.type === "peek.changed")
        setState((value) => ({ ...value, treeTick: value.treeTick + 1 }));
      else if (frame.type === "peek.selection_unavailable")
        setState((value) => ({
          ...value,
          unavailable: true,
          childTick: value.childTick + 1,
        }));
      else {
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
    const visibility = (): void => {
      if (document.visibilityState === "hidden") {
        es.close();
        if (active.current === es) active.current = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else {
        attempts.current = 0;
        setConnection((value) => value + 1);
      }
    };

    document.addEventListener("visibilitychange", visibility);
    if (document.visibilityState === "hidden") visibility();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibility);
      if (timer) clearTimeout(timer);
      es.close();
      if (active.current === es) active.current = null;
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
      selectionUnavailable: state.selection === selected && state.unavailable,
    };
  }, [state, selected, reconnect]);
}
