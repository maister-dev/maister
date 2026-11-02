"use client";

import type { ReactNode } from "react";
import type { RunPeekSnapshot } from "@/lib/runs/peek-types";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { RunPeekContent } from "@/components/runs/run-peek-content";
import { useModalA11y } from "@/components/use-modal-a11y";
import { RunPeekLink, useRunPeek } from "@/components/runs/run-peek-controller";
import {
  RunChildPageList,
  RunExecutionStatus,
  RunResultStatus,
} from "@/components/runs/run-peek-navigation";
import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";

type SnapshotState = {
  selected: string;
  snapshot: RunPeekSnapshot | null;
  error: number | null;
  reason: string | null;
  loading: boolean;
};
function usePeekSnapshot(): {
  snapshot: RunPeekSnapshot | null;
  error: number | null;
  reason: string | null;
  loading: boolean;
  retry: () => void;
} {
  const peek = useRunPeek()!;
  const stream = useWorkbenchStream();
  const selected = peek.selected!;
  const [state, setState] = useState<SnapshotState>({
    selected,
    snapshot: null,
    error: null,
    reason: null,
    loading: true,
  });
  const [retryKey, setRetryKey] = useState(0);
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true,
      inflight = false,
      dirty = false;
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      if (inflight) {
        dirty = true;

        return;
      }
      inflight = true;
      try {
        const query = new URLSearchParams({ selected });

        if (peek.node) query.set("node", peek.node);
        const response = await fetch(`/api/runs/${peek.anchor}/peek?${query}`, {
          signal: controller.signal,
        });

        if (!active) return;
        if (!response.ok) {
          const failure: { reason?: string } = await response.json();

          if (!active) return;
          setState({
            selected,
            snapshot: null,
            error: response.status,
            reason: failure.reason ?? null,
            loading: false,
          });

          return;
        }
        const snapshot: RunPeekSnapshot = await response.json();

        if (
          active &&
          snapshot.selectedRunId === selected &&
          snapshot.anchorRunId === peek.anchor
        )
          setState({
            selected,
            snapshot,
            error: null,
            reason: null,
            loading: false,
          });
      } catch {
        if (active)
          setState({
            selected,
            snapshot: null,
            error: 503,
            reason: null,
            loading: false,
          });
      } finally {
        inflight = false;
        if (dirty && active) {
          dirty = false;
          void load();
        }
      }
    };

    loadRef.current = () => {
      void load();
    };
    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [selected, peek.anchor, peek.node, retryKey]);
  useEffect(() => {
    loadRef.current();
  }, [stream?.child.eventCount, stream?.treeTick]);
  const scopedError =
    state.selected === selected &&
    (state.reason === "hierarchy_invalid" ||
      state.reason === "hierarchy_limit");
  const unavailable = stream?.selectionUnavailable && !scopedError;

  return {
    snapshot:
      state.selected === selected && !unavailable ? state.snapshot : null,
    error: unavailable ? 404 : state.selected === selected ? state.error : null,
    reason: !unavailable && state.selected === selected ? state.reason : null,
    loading: state.selected !== selected || state.loading,
    retry: () => {
      stream?.child.reconnect();
      setRetryKey((key) => key + 1);
    },
  };
}

export function RunPeekPanel(): ReactNode {
  const peek = useRunPeek()!;
  const resource = usePeekSnapshot();
  const stream = useWorkbenchStream();
  const search = useSearchParams();
  const [wide, setWide] = useState<boolean | null>(() =>
    typeof window === "undefined"
      ? null
      : window.matchMedia("(min-width:1536px)").matches,
  );
  const focused = useRef<string | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width:1536px)");
    const change = (): void => setWide(media.matches);

    change();
    media.addEventListener("change", change);

    return () => media.removeEventListener("change", change);
  }, []);
  const modal = !wide || search.get("flow") === "fullscreen";

  useModalA11y(panel, peek.close, wide !== null && modal);
  useLayoutEffect(() => {
    if (modal || !panel.current?.contains(document.activeElement)) return;
    const retainedFocus = document.activeElement as HTMLElement;
    const frame = requestAnimationFrame(() => {
      if (retainedFocus.isConnected && panel.current?.contains(retainedFocus))
        retainedFocus.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [modal]);
  useEffect(() => {
    if (wide === null || focused.current === peek.selected) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      focused.current = peek.selected;
    });

    return () => cancelAnimationFrame(frame);
  }, [wide, peek.selected]);
  useEffect(() => {
    if (modal) return;
    const escape = (event: KeyboardEvent): void => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        panel.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        peek.close();
      }
    };

    document.addEventListener("keydown", escape);

    return () => document.removeEventListener("keydown", escape);
  }, [modal, peek.close]);
  useEffect(() => {
    if (!modal || !panel.current) return;
    const retained: { element: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = panel.current;

    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling === branch ||
          !(sibling instanceof HTMLElement) ||
          sibling.hasAttribute("data-peek-backdrop")
        )
          continue;
        retained.push({ element: sibling, inert: sibling.inert });
        sibling.setAttribute("inert", "");
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }

    return () => {
      for (const item of retained) {
        if (item.inert) item.element.setAttribute("inert", "");
        else item.element.removeAttribute("inert");
      }
    };
  }, [modal]);
  const snapshot = resource.snapshot;
  const t = peek.t;
  const hierarchyError =
    resource.reason === "hierarchy_invalid" ||
    resource.reason === "hierarchy_limit";
  const invalidNode = resource.reason === "invalid_node";

  return (
    <>
      {modal ? (
        <button
          aria-hidden
          data-peek-backdrop
          className="fixed inset-0 z-[90] cursor-default bg-black/30"
          tabIndex={-1}
          type="button"
          onClick={peek.close}
        />
      ) : null}
      <aside
        ref={panel}
        aria-labelledby="run-peek-heading"
        aria-modal={modal || undefined}
        className={
          modal
            ? "fixed inset-y-0 right-0 z-[100] flex w-full min-w-0 flex-col overflow-hidden border-l border-line bg-paper shadow-xl md:max-w-[560px]"
            : "sticky top-3 flex h-[calc(100dvh-24px)] min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-paper"
        }
        data-modal={modal ? "true" : "false"}
        data-selected-run={peek.selected}
        data-testid="run-peek-panel"
        role={modal ? "dialog" : "complementary"}
      >
        <header className="shrink-0 border-b border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              ref={heading}
              className="min-w-0 break-words text-lg font-semibold"
              id="run-peek-heading"
              tabIndex={-1}
            >
              {snapshot?.summary.label ?? t("title")}
            </h2>
            <button aria-label={t("close")} type="button" onClick={peek.close}>
              ×
            </button>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <button
              disabled={!peek.canPrevious}
              type="button"
              onClick={peek.previous}
            >
              {t("previous")}
            </button>
            {snapshot || hierarchyError || invalidNode ? (
              <a
                href={
                  snapshot?.fullRunHref ??
                  `/runs/${encodeURIComponent(peek.selected!)}`
                }
              >
                {t("openFull")}
              </a>
            ) : null}
          </div>
          {snapshot ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="my-2 break-words text-xs"
            >
              {snapshot.selectedRunId.slice(0, 8)} ·{" "}
              {t(`kind_${snapshot.summary.runKind}`)} ·{" "}
              <RunExecutionStatus status={snapshot.summary.status} />
              {snapshot.summary.resultStatus ? (
                <>
                  {" "}
                  · <RunResultStatus status={snapshot.summary.resultStatus} />
                </>
              ) : null}
            </p>
          ) : null}
          {stream?.child.liveness === "disconnected" ||
          stream?.child.liveness === "reconnecting" ? (
            <p role="status">
              {t("disconnected")}{" "}
              <button type="button" onClick={stream.child.reconnect}>
                {t("retry")}
              </button>
            </p>
          ) : null}
        </header>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-3"
          data-testid="run-peek-scroll"
        >
          {resource.error ? (
            <div role="status">
              {t(
                hierarchyError
                  ? "hierarchyError"
                  : invalidNode
                    ? "invalidNode"
                    : resource.error === 404 || resource.error === 400
                      ? "unavailable"
                      : resource.error === 403
                        ? "forbidden"
                        : "error",
              )}{" "}
              {invalidNode ? (
                <button type="button" onClick={() => peek.setNode(null)}>
                  {t("resetNode")}
                </button>
              ) : null}
              <button type="button" onClick={resource.retry}>
                {t("retry")}
              </button>
            </div>
          ) : null}
          {!snapshot && !resource.error ? (
            <p role="status">{t("loading")}</p>
          ) : null}
          {snapshot ? (
            <>
              <nav aria-label={t("hierarchy")}>
                <ol className="flex list-none flex-wrap gap-2 p-0">
                  {snapshot.breadcrumbs.map((item) => (
                    <li key={item.runId}>
                      <RunPeekLink runId={item.runId}>{item.label}</RunPeekLink>
                    </li>
                  ))}
                </ol>
              </nav>
              <p className="text-sm text-mute">
                {t(
                  snapshot.workspace === "none"
                    ? "noWorkspace"
                    : snapshot.workspace === "removed"
                      ? "removedWorkspace"
                      : "workspacePresent",
                )}
              </p>
              <p>{t("detailsFull")}</p>
              <RunPeekContent snapshot={snapshot} />
              <section aria-label={t("siblings")}>
                <h3>{t("siblings")}</h3>
                <RunChildPageList
                  key={`siblings:${snapshot.breadcrumbs.at(-2)?.runId}`}
                  parentId={snapshot.breadcrumbs.at(-2)?.runId ?? peek.anchor}
                />
              </section>
              <section aria-label={t("children")}>
                <h3>{t("children")}</h3>
                <RunChildPageList
                  key={`children:${snapshot.selectedRunId}`}
                  parentId={snapshot.selectedRunId}
                />
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
