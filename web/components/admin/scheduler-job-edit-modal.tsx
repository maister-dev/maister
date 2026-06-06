"use client";

import type { SchedulerJobRow } from "@/components/admin/scheduler-jobs-table";
import type { SchedulerJobKind } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

const JOB_KINDS: SchedulerJobKind[] = [
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
];

export interface SchedulerJobEditModalProps {
  job: SchedulerJobRow | null;
  onClose: () => void;
  onSaved: () => void;
}

export function SchedulerJobEditModal({
  job,
  onClose,
  onSaved,
}: SchedulerJobEditModalProps): ReactElement {
  const t = useTranslations("adminScheduler");
  const isCreate = job === null;

  const [id, setId] = useState(job?.id ?? "");
  const [jobKind, setJobKind] = useState<SchedulerJobKind>(
    job?.jobKind ?? "system_sweep",
  );
  const [cadence, setCadence] = useState(
    String(job?.cadenceIntervalSeconds ?? 60),
  );
  const [maxFailures, setMaxFailures] = useState(String(job?.maxFailures ?? 3));
  const [targetText, setTargetText] = useState(
    JSON.stringify(job?.target ?? {}, null, 2),
  );
  const [enabled, setEnabled] = useState(job ? job.disabledAt === null : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  function parseTarget(): Record<string, unknown> | null {
    const trimmed = targetText.trim();

    if (trimmed.length === 0) return {};

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        setError(t("targetMustBeObject"));

        return null;
      }

      return parsed as Record<string, unknown>;
    } catch {
      setError(t("targetInvalidJson"));

      return null;
    }
  }

  async function save(): Promise<void> {
    setError(null);

    const target = parseTarget();

    if (target === null) return;

    const cadenceNum = Number.parseInt(cadence, 10);
    const maxFailuresNum = Number.parseInt(maxFailures, 10);

    if (!Number.isInteger(cadenceNum) || cadenceNum < 1) {
      setError(t("cadenceInvalid"));

      return;
    }
    if (!Number.isInteger(maxFailuresNum) || maxFailuresNum < 1) {
      setError(t("maxFailuresInvalid"));

      return;
    }

    setBusy(true);

    try {
      const res = isCreate
        ? await fetch("/api/admin/scheduler-jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: id.trim() || undefined,
              jobKind,
              target,
              cadenceIntervalSeconds: cadenceNum,
              maxFailures: maxFailuresNum,
            }),
          })
        : await fetch(`/api/admin/scheduler-jobs/${job.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target,
              cadenceIntervalSeconds: cadenceNum,
              maxFailures: maxFailuresNum,
              enabled,
            }),
          });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        setError(
          body?.message ?? body?.code ?? `Request failed: ${res.status}`,
        );

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!job) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/scheduler-jobs/${job.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        setError(
          body?.message ?? body?.code ?? `Request failed: ${res.status}`,
        );

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="scheduler-job-edit-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2
              className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
              id="scheduler-job-edit-title"
            >
              {isCreate ? t("createTitle") : t("editTitle")}
            </h2>
            {!isCreate ? (
              <div className="mt-1 truncate font-mono text-[11px] tracking-[0.03em] text-mute">
                {job.id}
              </div>
            ) : null}
          </div>
          <button
            aria-label={t("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          {isCreate ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("idLabel")}</span>
                <input
                  className={inputClass}
                  disabled={busy}
                  placeholder={t("idPlaceholder")}
                  spellCheck={false}
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("kindLabel")}</span>
                <select
                  className={inputClass}
                  disabled={busy}
                  value={jobKind}
                  onChange={(e) =>
                    setJobKind(e.target.value as SchedulerJobKind)
                  }
                >
                  {JOB_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kind.${kind}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("cadence")}</span>
              <input
                className={inputClass}
                disabled={busy}
                inputMode="numeric"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("maxFailures")}</span>
              <input
                className={inputClass}
                disabled={busy}
                inputMode="numeric"
                value={maxFailures}
                onChange={(e) => setMaxFailures(e.target.value)}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("target")}</span>
            <textarea
              className={clsx(inputClass, "min-h-[120px] py-2 leading-[1.5]")}
              disabled={busy}
              spellCheck={false}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
            />
            <span className="font-mono text-[10px] text-mute">
              {t(`targetHint.${jobKind}`)}
            </span>
          </label>

          {!isCreate ? (
            <label className="flex items-center gap-2 text-[12px] text-mute">
              <input
                checked={enabled}
                disabled={busy}
                type="checkbox"
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t("enabledLabel")}
            </label>
          ) : null}

          {error ? (
            <div
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
          <div>
            {!isCreate ? (
              <button
                className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-danger hover:border-danger"
                disabled={busy}
                type="button"
                onClick={() => void remove()}
              >
                {t("delete")}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(
                "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
                busy && "opacity-60",
              )}
              disabled={busy}
              type="button"
              onClick={() => void save()}
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
