"use client";

import type { Viewport } from "@xyflow/react";
import type { ReactElement, RefObject } from "react";

import { ArrowsPointingOutIcon } from "@heroicons/react/24/outline";
import {
  ControlButton,
  Controls,
  getViewportForBounds,
  Panel,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";

export const GRAPH_MIN_ZOOM = 0.03;
const OVERVIEW_PADDING = 0.14;
const NODE_ZOOM = 0.95;

export function useGraphViewportLabels() {
  const t = useTranslations("graphViewport");

  return {
    "controls.fitView.ariaLabel": t("fit"),
    "controls.zoomIn.ariaLabel": t("zoomIn"),
    "controls.zoomOut.ariaLabel": t("zoomOut"),
  };
}

export function GraphViewportControls({
  cameraRef,
  nodes,
  onLocate,
}: {
  cameraRef: RefObject<Viewport | null>;
  nodes: readonly { id: string; label: string }[];
  onLocate: (id: string) => void;
}): ReactElement {
  const viewport = useReactFlow();
  const ready = useStore(
    (state) =>
      state.nodes.length > 0 &&
      [...state.nodeLookup.values()].every(
        (node) =>
          node.hidden ||
          Boolean(
            (node.measured.width ?? node.width) &&
            (node.measured.height ?? node.height),
          ),
      ),
  );
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const viewportReady = useStore((state) => state.panZoom !== null);
  const restored = useRef(false);
  const t = useTranslations("graphViewport");
  const fit = useCallback((): void => {
    if (!viewportReady || !ready || width <= 0 || height <= 0) return;

    const ids = viewport
      .getNodes()
      .filter((node) => !node.hidden)
      .map((node) => node.id);
    const bounds = viewport.getNodesBounds(ids);

    if (ids.length > 0)
      void viewport.setViewport(
        getViewportForBounds(
          bounds,
          width,
          height,
          GRAPH_MIN_ZOOM,
          NODE_ZOOM,
          OVERVIEW_PADDING,
        ),
      );
  }, [height, ready, viewport, viewportReady, width]);

  useEffect(() => {
    if (!viewportReady || !ready || width <= 0 || height <= 0) return;

    if (!restored.current && cameraRef.current) {
      void viewport.setViewport(cameraRef.current);
    } else if (!cameraRef.current) {
      fit();
    }

    restored.current = true;
  }, [cameraRef, fit, height, ready, viewport, viewportReady, width]);

  const remember = (): void => {
    cameraRef.current = viewport.getViewport();
  };

  function locate(id: string): void {
    const node = viewport.getNode(id);

    if (!node) return;

    const bounds = viewport.getNodesBounds([id]);

    remember();
    void viewport.setCenter(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      { zoom: NODE_ZOOM },
    );
    onLocate(id);
  }

  return (
    <>
      <Controls
        showFitView={false}
        showInteractive={false}
        onZoomIn={remember}
        onZoomOut={remember}
      >
        <ControlButton
          aria-label={t("fit")}
          className="react-flow__controls-fitview"
          title={t("fit")}
          onClick={() => {
            cameraRef.current = null;
            fit();
          }}
        >
          <ArrowsPointingOutIcon aria-hidden="true" />
        </ControlButton>
      </Controls>
      {nodes.length > 1 ? (
        <Panel position="top-right">
          <select
            aria-label={t("locate")}
            className="max-w-[min(15rem,65vw)] rounded border border-line bg-paper p-1 text-xs text-ink"
            value=""
            onChange={(event) => locate(event.target.value)}
          >
            <option value="">{t("locate")}</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </Panel>
      ) : null}
    </>
  );
}
