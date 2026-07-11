"use client";

import type {
  DiffViewLabels,
  PreparedFile,
  RunDiffFile,
} from "@/components/workbench/diff-view";
import type { ReactElement } from "react";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { DiffView } from "@/components/workbench/diff-view";

// ADR-129 (T18): read-only fork-vs-upstream divergence drawer — the
// LocalPackageDiffDrawer pattern minus the commit/discard bar. Ours = the
// fork working dir (default) or one of its cuts (header picker); theirs =
// the lineage source install. A GC'd/unlinked source (422 CONFIG) renders a
// DEGRADED panel, not a generic failure. `element` narrows to one
// composition element (opened from a composition card's compare entry).
export type DivergenceCutOption = { installId: string; versionLabel: string };

type DivergenceDto = {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  truncated: boolean;
  changedCount: number;
  base: { installId: string; versionLabel: string };
  compared:
    | { kind: "working_dir" }
    | { kind: "cut"; installId: string; versionLabel: string };
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; divergence: DivergenceDto }
  | { kind: "degraded"; message: string }
  | { kind: "error"; message: string };

export function UpstreamDivergenceDrawer({
  packageId,
  cuts,
  element,
  diffViewLabels,
  onClose,
}: {
  packageId: string;
  cuts: DivergenceCutOption[];
  // Package-relative element path scope; null = whole package.
  element: string | null;
  diffViewLabels: DiffViewLabels;
  onClose: () => void;
}): ReactElement {
  const t = useTranslations("studio");
  const [source, setSource] = useState<string>("working_dir");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const params = new URLSearchParams();

      if (source !== "working_dir") params.set("cutInstallId", source);
      if (element !== null) params.set("element", element);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/divergence${query}`,
      );
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (!res.ok) {
        // The typed "source install unavailable" degradation (CONFIG); the
        // render supplies the localized headline, this keeps the raw detail.
        if (body?.code === "CONFIG") {
          setState({ kind: "degraded", message: body.message ?? "" });
        } else {
          setState({
            kind: "error",
            message: body?.message ?? `HTTP ${res.status}`,
          });
        }

        return;
      }
      if (body === null) {
        setState({ kind: "error", message: "malformed divergence response" });

        return;
      }

      setState({ kind: "ready", divergence: body as unknown as DivergenceDto });
    } catch (err) {
      // eslint-disable-next-line no-console -- client boundary per editor idiom
      console.warn("[divergence] load failed", { packageId, err });
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [packageId, source, element]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      aria-labelledby="upstream-divergence-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-[980px] flex-col gap-3 rounded-[16px] border border-line bg-paper p-5 shadow-xl">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <h3
            className="m-0 mr-auto font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
            id="upstream-divergence-title"
          >
            {t("divergence.title")}
            {element !== null ? (
              <span className="ml-2 normal-case tracking-normal text-ink">
                {element}
              </span>
            ) : null}
          </h3>
          {state.kind === "ready" ? (
            <span
              className="rounded-md border border-line bg-ivory px-2 py-1 font-mono text-[11px] text-ink"
              data-testid="divergence-base"
            >
              {t("divergence.base", {
                label: state.divergence.base.versionLabel,
              })}
            </span>
          ) : null}
          <label className="sr-only" htmlFor="divergence-source-select">
            {t("divergence.sourcePick")}
          </label>
          <select
            className="h-8 rounded-md border border-line bg-ivory px-2 font-mono text-[11px] text-ink"
            data-testid="divergence-source-select"
            id="divergence-source-select"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="working_dir">
              {t("divergence.sourceWorkingDir")}
            </option>
            {cuts.map((cut) => (
              <option key={cut.installId} value={cut.installId}>
                {cut.versionLabel}
              </option>
            ))}
          </select>
          <button
            className="rounded-md border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink hover:border-amber"
            data-testid="divergence-close"
            type="button"
            onClick={onClose}
          >
            {t("divergence.close")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {state.kind === "loading" ? (
            <p className="p-4 text-center font-mono text-[11px] text-mute">…</p>
          ) : state.kind === "degraded" ? (
            <div
              className="rounded-md border border-amber/40 bg-amber/10 px-3 py-3 text-[12.5px] leading-[1.5] text-ink"
              data-testid="divergence-degraded"
              role="alert"
            >
              <p className="m-0 font-semibold">{t("divergence.degraded")}</p>
              <p className="m-0 mt-1 font-mono text-[11px] text-mute">
                {state.message}
              </p>
            </div>
          ) : state.kind === "error" ? (
            <p
              className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
              data-testid="divergence-error"
              role="alert"
            >
              {state.message}
            </p>
          ) : state.divergence.changedCount === 0 ? (
            <p
              className="rounded-md border border-line bg-paper p-4 font-mono text-[11px] text-mute"
              data-testid="divergence-clean"
            >
              {t("divergence.clean")}
            </p>
          ) : (
            <DiffView
              files={state.divergence.files}
              labels={diffViewLabels}
              perFile={state.divergence.perFile}
              truncated={state.divergence.truncated}
              onRefresh={() => void load()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
