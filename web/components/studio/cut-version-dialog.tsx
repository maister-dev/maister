"use client";

import type { ReactElement } from "react";

import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// ADR-132 §c (T16): the Studio cut dialog. Cutting is the primary action; the
// multi-select additionally advances ALREADY-ATTACHED projects (only those
// whose attachment points at a cut of THIS package — server-validated again
// pre-cut) to the new cut. Default: none selected — adopting is an explicit
// per-project choice, never background. Failed adopts are retryable: the cut
// is content-addressed, so re-submitting with the failed projects re-uses the
// identical install and only re-runs the adopts.
export type CutAdoptTarget = { projectId: string; name: string };

type Adoption = {
  projectId: string;
  status: "adopted" | "failed";
  error?: string;
};

type Step =
  | { kind: "pick" }
  | { kind: "cutting" }
  | { kind: "error"; message: string }
  | { kind: "done"; versionLabel: string; adoptions: Adoption[] };

type Props = {
  packageId: string;
  packageName: string;
  adoptTargets: CutAdoptTarget[];
  onClose: () => void;
  // Fired once per successful cut so the parent can surface its notice +
  // refresh; the dialog stays open to show per-project adopt results.
  onCut: (versionLabel: string) => void;
};

export function CutVersionDialog({
  packageId,
  packageName,
  adoptTargets,
  onClose,
  onCut,
}: Props): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>({ kind: "pick" });

  const busy = step.kind === "cutting";
  const nameByProject = new Map(
    adoptTargets.map((tgt) => [tgt.projectId, tgt.name]),
  );

  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;
  useEffect(() => {
    dialogRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggle(projectId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);

      return next;
    });
  }

  async function cut(adoptIds: string[]): Promise<void> {
    setStep({ kind: "cutting" });
    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/cut-version`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            adoptIds.length > 0 ? { adoptInProjectIds: adoptIds } : {},
          ),
        },
      );

      if (!res.ok) {
        setStep({
          kind: "error",
          message: await readApiError(res, tApiErrors),
        });

        return;
      }
      const result = (await res.json()) as {
        versionLabel: string;
        adoptions?: Adoption[];
      };

      onCut(result.versionLabel);
      setStep({
        kind: "done",
        versionLabel: result.versionLabel,
        adoptions: result.adoptions ?? [],
      });
    } catch {
      setStep({
        kind: "error",
        message: tApiErrors("requestFailed"),
      });
    }
  }

  const failedIds =
    step.kind === "done"
      ? step.adoptions
          .filter((a) => a.status === "failed")
          .map((a) => a.projectId)
      : [];

  return (
    <div
      aria-labelledby="cut-version-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
    >
      <div
        ref={dialogRef}
        className="flex max-h-[80vh] w-full max-w-[480px] flex-col gap-4 rounded-[16px] border border-line bg-paper p-6 shadow-xl outline-none"
        tabIndex={-1}
      >
        <h3
          className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
          id="cut-version-dialog-title"
        >
          {t("local.cutDialogTitle", { name: packageName })}
        </h3>

        {step.kind === "done" ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[13px] text-ink">
              <CheckCircleIcon className="mr-1.5 inline h-4 w-4 text-emerald-600" />
              {t("local.cutDialogDone", { label: step.versionLabel })}
            </p>
            {step.adoptions.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {step.adoptions.map((adoption) => (
                  <li
                    key={adoption.projectId}
                    className="flex items-center gap-2 text-[12.5px] text-ink"
                    data-testid={`cut-adopt-${adoption.status}`}
                  >
                    {adoption.status === "adopted" ? (
                      <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <XCircleIcon className="h-4 w-4 shrink-0 text-rose-600" />
                    )}
                    <span className="font-medium">
                      {nameByProject.get(adoption.projectId) ??
                        adoption.projectId}
                    </span>
                    {adoption.error ? (
                      <span className="text-[11.5px] text-mute">
                        {adoption.error}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end gap-2">
              {failedIds.length > 0 ? (
                <button
                  className="rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink hover:border-amber"
                  data-testid="cut-retry-failed"
                  type="button"
                  onClick={() => void cut(failedIds)}
                >
                  {t("local.cutDialogRetryFailed")}
                </button>
              ) : null}
              <button
                className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
                type="button"
                onClick={onClose}
              >
                {t("local.cutDialogClose")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {adoptTargets.length > 0 ? (
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-1 p-0 text-[12.5px] leading-[1.5] text-mute">
                  {t("local.cutDialogAdoptLead")}
                </legend>
                {adoptTargets.map((target) => (
                  <label
                    key={target.projectId}
                    className="flex items-center gap-2 text-[13px] text-ink"
                  >
                    <input
                      checked={selected.has(target.projectId)}
                      className="h-4 w-4 accent-amber"
                      data-testid={`cut-adopt-check-${target.projectId}`}
                      disabled={busy}
                      type="checkbox"
                      onChange={() => toggle(target.projectId)}
                    />
                    {target.name}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="m-0 text-[12.5px] leading-[1.5] text-mute">
                {t("local.cutDialogNoTargets")}
              </p>
            )}

            {step.kind === "error" ? (
              <p
                className="m-0 rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
                role="alert"
              >
                {step.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                className="rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
                disabled={busy}
                type="button"
                onClick={onClose}
              >
                {t("local.cutDialogCancel")}
              </button>
              <button
                className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                data-testid="cut-dialog-submit"
                disabled={busy}
                type="button"
                onClick={() => void cut([...selected])}
              >
                {t("local.cutDialogCut")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
