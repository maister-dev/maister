"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

type LaunchOptions = {
  branches: string[];
  defaultBaseBranch: string | null;
};

// M33 (ADR-088 D11) launch-verdict pre-fills — triage stamps them, the
// popover edits them; edits persist via ONE aggregating PATCH before launch.
export interface LaunchVerdict {
  flowId: string | null;
  runnerId: string | null;
  targetBranch: string | null;
  promotionMode: "local_merge" | "pull_request" | null;
}

export interface LaunchPopoverProps {
  taskId: string;
  projectId: string;
  slug: string;
  taskNumber: number;
  verdict: LaunchVerdict;
  flowOptions: Array<{ id: string; label: string }>;
  runnerOptions: Array<{ id: string; label: string }>;
  label: string;
  disabledLabel: string;
  disabledReason?: string;
}

export function LaunchPopover({
  taskId,
  projectId,
  slug,
  taskNumber,
  verdict,
  flowOptions,
  runnerOptions,
  label,
  disabledLabel,
  disabledReason,
}: LaunchPopoverProps): ReactElement {
  const t = useTranslations("launch");
  const tRun = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [flowId, setFlowId] = useState(verdict.flowId ?? "");
  const [runnerId, setRunnerId] = useState(verdict.runnerId ?? "");
  const [promotionMode, setPromotionMode] = useState(
    verdict.promotionMode ?? "",
  );
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const unconfigured = verdict.flowId === null;
  const disabled = busy || pending || Boolean(disabledReason);

  useEffect(() => {
    if (!advancedOpen || options || loadingOptions) return;

    const controller = new AbortController();

    setLoadingOptions(true);
    setOptionsError(false);

    fetch(
      `/api/scratch-runs/launch-options?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));

        return (await res.json()) as LaunchOptions;
      })
      .then((payload) => {
        const resolvedBase =
          payload.defaultBaseBranch ?? payload.branches[0] ?? "";

        setOptions(payload);
        setBaseBranch(resolvedBase);
        // The verdict target branch pre-fills when it names a real branch;
        // the launch path re-validates against the repo either way.
        setTargetBranch(
          verdict.targetBranch &&
            payload.branches.includes(verdict.targetBranch)
            ? verdict.targetBranch
            : resolvedBase,
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOptionsError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingOptions(false);
      });

    return () => controller.abort();
  }, [advancedOpen, loadingOptions, options, projectId, verdict.targetBranch]);

  useEffect(() => {
    if (!advancedOpen) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setAdvancedOpen(false);
    }

    function onPointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) {
        setAdvancedOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [advancedOpen]);

  // Diff vs the stored verdict — one aggregating PATCH, only changed keys,
  // "" select values clear with explicit null (SET/CLEAR symmetric).
  async function persistVerdict(): Promise<boolean> {
    const patch: Record<string, string | null> = {};

    if ((verdict.flowId ?? "") !== flowId) patch.flowId = flowId || null;
    if ((verdict.runnerId ?? "") !== runnerId) {
      patch.runnerId = runnerId || null;
    }
    if ((verdict.promotionMode ?? "") !== promotionMode) {
      patch.promotionMode = promotionMode || null;
    }
    if (targetBranch && verdict.targetBranch !== targetBranch) {
      patch.targetBranch = targetBranch;
    }

    if (Object.keys(patch).length === 0) return true;

    const res = await fetch(`/api/projects/${slug}/tasks/${taskNumber}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        code?: string;
      } | null;

      setError(data?.code ?? "CRASH");

      return false;
    }

    return true;
  }

  async function launch(advanced?: {
    baseBranch: string;
    targetBranch: string;
  }): Promise<void> {
    if (disabledReason) return;

    // A flowless task cannot launch — the popover collects the missing
    // fields (D11: same popover, fields required).
    if (!advanced && unconfigured) {
      setAdvancedOpen(true);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (advanced) {
        const persisted = await persistVerdict();

        if (!persisted) return;
      }

      const body: {
        taskId: string;
        runnerId?: string;
        baseBranch?: string;
        targetBranch?: string;
      } = { taskId };

      if (advanced) {
        if (runnerId) body.runnerId = runnerId;
        if (advanced.baseBranch) body.baseBranch = advanced.baseBranch;
        if (advanced.targetBranch) body.targetBranch = advanced.targetBranch;
      }

      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      setAdvancedOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "min-w-0 flex-1 rounded-md border border-line-soft bg-paper px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-amber";
  const fieldLabelClass =
    "font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute";

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <button
        className={clsx(
          "inline-flex items-center gap-1 rounded-md border border-transparent px-[9px] py-[5px] font-mono text-[10px] font-bold uppercase leading-none tracking-[0.06em] text-amber transition-all",
          "group-hover/task:border-amber-line group-hover/task:bg-amber-soft",
          "hover:!border-amber hover:!bg-amber hover:!text-white",
          disabled && "cursor-not-allowed opacity-60",
        )}
        disabled={disabled}
        title={
          error ?? disabledReason ?? (unconfigured ? t("setUp") : undefined)
        }
        type="button"
        onClick={() => void launch()}
      >
        {error ??
          (disabledReason ? disabledLabel : unconfigured ? t("setUp") : label)}
      </button>
      <button
        aria-controls={panelId}
        aria-expanded={advancedOpen}
        aria-label={t("advanced")}
        className={clsx(
          "inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-transparent font-mono text-[11px] leading-none text-mute transition-all",
          "group-hover/task:border-line-soft hover:!border-amber hover:!text-amber",
          advancedOpen && "border-amber-line bg-amber-soft text-amber",
          disabled && "cursor-not-allowed opacity-60",
        )}
        disabled={disabled}
        title={t("advanced")}
        type="button"
        onClick={() => setAdvancedOpen((current) => !current)}
      >
        ⋯
      </button>

      {advancedOpen ? (
        <section
          aria-label={t("advanced")}
          className="absolute right-0 top-[calc(100%+6px)] z-20 w-[252px] rounded-[10px] border border-line bg-paper p-3 shadow-[0_18px_44px_-22px_rgba(22,20,15,0.32)]"
          id={panelId}
        >
          {loadingOptions ? (
            <p className="font-mono text-[11px] text-mute">{t("loading")}</p>
          ) : optionsError ? (
            <p
              aria-live="polite"
              className="font-mono text-[11px] text-[#d9534f]"
              role="alert"
            >
              {t("optionsError")}
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>
                  {t("flow")}
                  {unconfigured ? " *" : ""}
                </span>
                <select
                  aria-label={t("flow")}
                  className={selectClass}
                  value={flowId}
                  onChange={(event) => setFlowId(event.target.value)}
                >
                  {unconfigured ? <option value="">—</option> : null}
                  {flowOptions.map((flow) => (
                    <option key={flow.id} value={flow.id}>
                      {flow.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t("runner")}</span>
                <select
                  aria-label={t("runner")}
                  className={selectClass}
                  value={runnerId}
                  onChange={(event) => setRunnerId(event.target.value)}
                >
                  <option value="">{t("runnerDefault")}</option>
                  {runnerOptions.map((runner) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t("promotionMode")}</span>
                <select
                  aria-label={t("promotionMode")}
                  className={selectClass}
                  value={promotionMode}
                  onChange={(event) => setPromotionMode(event.target.value)}
                >
                  <option value="">{t("promotionDefault")}</option>
                  <option value="local_merge">
                    {t("promotionLocalMerge")}
                  </option>
                  <option value="pull_request">
                    {t("promotionPullRequest")}
                  </option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{tRun("baseBranch")}</span>
                <select
                  aria-label={tRun("baseBranch")}
                  className={selectClass}
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                >
                  {options?.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{tRun("targetBranch")}</span>
                <select
                  aria-label={tRun("targetBranch")}
                  className={selectClass}
                  value={targetBranch}
                  onChange={(event) => setTargetBranch(event.target.value)}
                >
                  {options?.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={clsx(
                  "mt-0.5 inline-flex items-center justify-center rounded-md bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white transition-all hover:bg-amber-2",
                  (busy || pending || !baseBranch || !flowId) &&
                    "cursor-not-allowed opacity-60",
                )}
                disabled={busy || pending || !baseBranch || !flowId}
                type="button"
                onClick={() => void launch({ baseBranch, targetBranch })}
              >
                {label}
              </button>
              {error ? (
                <p
                  aria-live="polite"
                  className="font-mono text-[10.5px] text-[#d9534f]"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
