"use client";

import type { ReactElement } from "react";
import type {
  AttachScheduleView,
  AttachedAgentRow,
  AutoApplyMode,
  ExecutionPolicyOverrideView,
  OnBudgetBreachMode,
} from "@/components/board/panels/agents-attach-panel";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export async function sendJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${res.status}`);
  }
}

type EditableSchedule = {
  triggerType: "cron" | "event";
  cronExpr: string;
  timezone: string;
  eventKinds: string[];
  enabled: boolean;
};

function toEditable(s: AttachScheduleView): EditableSchedule {
  return {
    triggerType: s.triggerType,
    cronExpr: s.cronExpr ?? "",
    timezone: s.timezone ?? "UTC",
    eventKinds: s.eventKinds ?? [],
    enabled: s.enabled,
  };
}

export function AttachEditModal({
  slug,
  row,
  runners,
  eventKinds,
  attachAgentId,
  onClose,
  onSaved,
}: {
  slug: string;
  row: AttachedAgentRow;
  runners: Array<{ id: string; label: string }>;
  eventKinds: string[];
  // Attach mode (RD5): Save POSTs the attachment first, then the bindings.
  attachAgentId?: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const t = useTranslations("agentsAttach");
  const rec = row.agent.recommended;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(row.enabled);
  const [runnerOverrideId, setRunnerOverrideId] = useState(
    row.runnerOverrideId ?? "",
  );
  // (ADR-106) Per-instance policy overrides. "" → inherit (clears the column on
  // Save → effective resolution falls back to the agent `recommended`).
  const [branchBase, setBranchBase] = useState(row.branchBase ?? "");
  const [autoApply, setAutoApply] = useState<"" | AutoApplyMode>(
    row.executionPolicyOverride?.autoApply ?? "",
  );
  const [onBudgetBreach, setOnBudgetBreach] = useState<"" | OnBudgetBreachMode>(
    row.executionPolicyOverride?.onBudgetBreach ?? "",
  );
  const [schedules, setSchedules] = useState<EditableSchedule[]>(
    row.schedules.map(toEditable),
  );

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

  function patchSchedule(
    index: number,
    patch: Partial<EditableSchedule>,
  ): void {
    setSchedules((current) =>
      current.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }

  function toggleKind(index: number, kind: string): void {
    setSchedules((current) =>
      current.map((s, i) =>
        i === index
          ? {
              ...s,
              eventKinds: s.eventKinds.includes(kind)
                ? s.eventKinds.filter((k) => k !== kind)
                : [...s.eventKinds, kind],
            }
          : s,
      ),
    );
  }

  const valid = schedules.every((s) =>
    s.triggerType === "cron"
      ? s.cronExpr.trim() !== "" && s.timezone.trim() !== ""
      : s.eventKinds.length > 0,
  );

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (attachAgentId) {
        await sendJson(`/api/projects/${slug}/agents`, "POST", {
          agentId: attachAgentId,
          enabled,
          runnerOverrideId: runnerOverrideId === "" ? null : runnerOverrideId,
        });
      }

      const policyOverride: ExecutionPolicyOverrideView | null =
        autoApply === "" && onBudgetBreach === ""
          ? null
          : {
              ...(autoApply !== "" ? { autoApply } : {}),
              ...(onBudgetBreach !== "" ? { onBudgetBreach } : {}),
            };

      await sendJson(`/api/projects/${slug}/agents/${row.agent.id}`, "PATCH", {
        enabled,
        runnerOverrideId: runnerOverrideId === "" ? null : runnerOverrideId,
        branchBase: branchBase.trim() === "" ? null : branchBase.trim(),
        executionPolicyOverride: policyOverride,
        schedules: schedules.map((s) =>
          s.triggerType === "cron"
            ? {
                triggerType: "cron",
                cronExpr: s.cronExpr.trim(),
                timezone: s.timezone.trim(),
                enabled: s.enabled,
              }
            : {
                triggerType: "event",
                eventKinds: s.eventKinds,
                enabled: s.enabled,
              },
        ),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "min-h-[34px] rounded-lg border border-line bg-paper px-2.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
  const fieldLabel =
    "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

  // The inherit option names what an unset field resolves to (the agent
  // `recommended`), so leaving it untouched is an informed choice.
  const autoApplyInheritLabel = rec?.executionPolicy?.autoApply
    ? `${t("autoApplyInherit")} (${rec.executionPolicy.autoApply})`
    : t("autoApplyInherit");
  const budgetInheritLabel = rec?.executionPolicy?.onBudgetBreach
    ? `${t("budgetInherit")} (${rec.executionPolicy.onBudgetBreach})`
    : t("budgetInherit");

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
        aria-labelledby="attach-edit-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2
            className="m-0 text-[15px] font-semibold text-ink"
            id="attach-edit-title"
          >
            {t("editTitle")} — {row.agent.id}
          </h2>
          <button
            aria-label={t("cancel")}
            className="rounded-md border border-line px-2 py-1 text-[12px] text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-5 py-4">
          <label className="inline-flex items-center gap-2 font-mono text-[12px] text-ink">
            <input
              checked={enabled}
              type="checkbox"
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t("linkEnabled")}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("runnerOverride")}</span>
            <select
              className={inputClass}
              value={runnerOverrideId}
              onChange={(event) => setRunnerOverrideId(event.target.value)}
            >
              <option value="">{t("runnerNone")}</option>
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("branchBase")}</span>
            <input
              className={inputClass}
              placeholder={rec?.branchBase ?? t("branchBaseInherit")}
              value={branchBase}
              onChange={(event) => setBranchBase(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("autoApply")}</span>
            <select
              className={inputClass}
              value={autoApply}
              onChange={(event) =>
                setAutoApply(event.target.value as "" | AutoApplyMode)
              }
            >
              <option value="">{autoApplyInheritLabel}</option>
              <option value="off">{t("autoApplyOff")}</option>
              <option value="permissions">{t("autoApplyPermissions")}</option>
              <option value="full">{t("autoApplyFull")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("onBudgetBreach")}</span>
            <select
              className={inputClass}
              value={onBudgetBreach}
              onChange={(event) =>
                setOnBudgetBreach(event.target.value as "" | OnBudgetBreachMode)
              }
            >
              <option value="">{budgetInheritLabel}</option>
              <option value="escalate">{t("budgetEscalate")}</option>
              <option value="terminate">{t("budgetTerminate")}</option>
              <option value="terminate_restorable">
                {t("budgetTerminateRestorable")}
              </option>
            </select>
          </label>

          <div className="flex items-center justify-between">
            <span className={fieldLabel}>{t("schedules")}</span>
            <div className="flex gap-2">
              <button
                className="h-8 rounded-[8px] border border-line px-2.5 text-[11.5px] font-semibold text-ink"
                type="button"
                onClick={() =>
                  setSchedules((current) => [
                    ...current,
                    {
                      triggerType: "cron",
                      cronExpr: "*/30 * * * *",
                      timezone: "UTC",
                      eventKinds: [],
                      enabled: true,
                    },
                  ])
                }
              >
                {t("addCron")}
              </button>
              <button
                className="h-8 rounded-[8px] border border-line px-2.5 text-[11.5px] font-semibold text-ink"
                type="button"
                onClick={() =>
                  setSchedules((current) => [
                    ...current,
                    {
                      triggerType: "event",
                      cronExpr: "",
                      timezone: "UTC",
                      eventKinds: [],
                      enabled: true,
                    },
                  ])
                }
              >
                {t("addEvent")}
              </button>
            </div>
          </div>

          {schedules.length === 0 ? (
            <p className="m-0 text-[12px] text-mute">{t("noSchedules")}</p>
          ) : null}
          {schedules.map((schedule, index) => (
            <article
              key={index}
              className="rounded-[10px] border border-line-soft bg-ivory/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">
                  {schedule.triggerType === "cron"
                    ? t("cronRow")
                    : t("eventRow")}
                </span>
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink">
                    <input
                      checked={schedule.enabled}
                      type="checkbox"
                      onChange={(event) =>
                        patchSchedule(index, { enabled: event.target.checked })
                      }
                    />
                    {t("scheduleEnabled")}
                  </label>
                  <button
                    aria-label={t("removeSchedule")}
                    className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink"
                    type="button"
                    onClick={() =>
                      setSchedules((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    ✕
                  </button>
                </div>
              </div>
              {schedule.triggerType === "cron" ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabel}>{t("cronExpr")}</span>
                    <input
                      className={inputClass}
                      value={schedule.cronExpr}
                      onChange={(event) =>
                        patchSchedule(index, { cronExpr: event.target.value })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabel}>{t("timezone")}</span>
                    <input
                      className={inputClass}
                      value={schedule.timezone}
                      onChange={(event) =>
                        patchSchedule(index, { timezone: event.target.value })
                      }
                    />
                  </label>
                </div>
              ) : (
                <fieldset className="m-0 border-0 p-0">
                  <legend className={fieldLabel}>{t("eventKinds")}</legend>
                  <div className="mt-1 flex flex-wrap gap-2.5">
                    {eventKinds.map((kind) => (
                      <label
                        key={kind}
                        className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-ink"
                      >
                        <input
                          checked={schedule.eventKinds.includes(kind)}
                          type="checkbox"
                          onChange={() => toggleKind(index, kind)}
                        />
                        {kind}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </article>
          ))}

          {error ? (
            <p
              aria-live="polite"
              className="m-0 text-[12px] leading-[1.45] text-red-700"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="h-9 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink"
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className="h-9 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={busy || !valid}
            type="button"
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
