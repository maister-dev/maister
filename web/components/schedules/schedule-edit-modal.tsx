"use client";

import type { RunScheduleOverlapPolicy } from "@/lib/db/schema";
import type { ScheduleDTO } from "@/lib/run-schedules/queries";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

const OVERLAP_POLICIES: RunScheduleOverlapPolicy[] = [
  "skip",
  "queue_one",
  "start_anyway",
];

export interface ScheduleTaskOption {
  id: string;
  title: string;
  status: string;
}

export type ScheduleDraft = {
  name: string;
  cronExpr: string;
  timezone: string;
  overlapPolicy: RunScheduleOverlapPolicy;
  runnerId: string | null;
  enabled: boolean;
};

export type SchedulePatch = {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  overlapPolicy?: RunScheduleOverlapPolicy;
  runnerId?: string | null;
  enabled?: boolean;
};

export function buildSchedulePatch(
  original: Pick<
    ScheduleDTO,
    "name" | "cronExpr" | "timezone" | "overlapPolicy" | "runnerId" | "enabled"
  >,
  draft: ScheduleDraft,
): SchedulePatch {
  const patch: SchedulePatch = {};

  if (draft.name !== original.name) patch.name = draft.name;
  if (draft.cronExpr !== original.cronExpr) patch.cronExpr = draft.cronExpr;
  if (draft.timezone !== original.timezone) patch.timezone = draft.timezone;
  if (draft.overlapPolicy !== original.overlapPolicy) {
    patch.overlapPolicy = draft.overlapPolicy;
  }
  if (draft.runnerId !== original.runnerId) patch.runnerId = draft.runnerId;
  if (draft.enabled !== original.enabled) patch.enabled = draft.enabled;

  return patch;
}

interface RunnerOption {
  id: string;
  model: string;
}

export interface ScheduleEditModalProps {
  schedule: ScheduleDTO | null;
  slug: string;
  tasks: ScheduleTaskOption[];
  onClose: () => void;
  onSaved: () => void;
}

export function ScheduleEditModal({
  schedule,
  slug,
  tasks,
  onClose,
  onSaved,
}: ScheduleEditModalProps): ReactElement {
  const t = useTranslations("projectSchedules");
  const isCreate = schedule === null;

  const [name, setName] = useState(schedule?.name ?? "");
  const [taskId, setTaskId] = useState(schedule?.taskId ?? "");
  const [cronExpr, setCronExpr] = useState(schedule?.cronExpr ?? "");
  const [timezone, setTimezone] = useState(
    () =>
      schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [overlapPolicy, setOverlapPolicy] = useState<RunScheduleOverlapPolicy>(
    schedule?.overlapPolicy ?? "skip",
  );
  const [runnerId, setRunnerId] = useState<string | null>(
    schedule?.runnerId ?? null,
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [runners, setRunners] = useState<RunnerOption[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  useEffect(() => {
    if (!taskId) {
      setRunners([]);

      return;
    }

    let cancelled = false;

    fetch(`/api/runs/launch-options?taskId=${encodeURIComponent(taskId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          body: {
            runners?: { id: string; model: string; enabled: boolean }[];
          } | null,
        ) => {
          if (cancelled || !body?.runners) return;

          setRunners(
            body.runners
              .filter((runner) => runner.enabled)
              .map((runner) => ({ id: runner.id, model: runner.model })),
          );
        },
      )
      .catch(() => {
        if (!cancelled) setRunners([]);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const runnerOptions =
    runnerId !== null && !runners.some((runner) => runner.id === runnerId)
      ? [{ id: runnerId, model: "" }, ...runners]
      : runners;

  async function save(): Promise<void> {
    setError(null);

    if (name.trim().length === 0) {
      setError(t("modal.nameRequired"));

      return;
    }
    if (isCreate && taskId.length === 0) {
      setError(t("modal.taskRequired"));

      return;
    }
    if (cronExpr.trim().length === 0) {
      setError(t("modal.cronRequired"));

      return;
    }

    const draft: ScheduleDraft = {
      name: name.trim(),
      cronExpr: cronExpr.trim(),
      timezone,
      overlapPolicy,
      runnerId,
      enabled,
    };

    if (!isCreate) {
      const patch = buildSchedulePatch(schedule, draft);

      if (Object.keys(patch).length === 0) {
        onClose();

        return;
      }

      await submit(
        `/api/projects/${slug}/schedules/${schedule.id}`,
        "PATCH",
        patch,
      );

      return;
    }

    await submit(`/api/projects/${slug}/schedules`, "POST", {
      ...draft,
      taskId,
    });
  }

  async function submit(
    url: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ): Promise<void> {
    setBusy(true);

    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setError(await errorLabel(res));

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

  async function errorLabel(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;

    if (body?.code === "CONFIG") {
      return body.message ?? t("modal.invalidInput");
    }

    return body?.message ?? body?.code ?? `Request failed: ${res.status}`;
  }

  async function remove(): Promise<void> {
    if (!schedule) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/schedules/${schedule.id}`,
        {
          method: "DELETE",
        },
      );

      if (!res.ok) {
        setError(await errorLabel(res));

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
        aria-label={t("modal.cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="schedule-edit-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2
              className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
              id="schedule-edit-title"
            >
              {isCreate ? t("modal.createTitle") : t("modal.editTitle")}
            </h2>
            {!isCreate ? (
              <div className="mt-1 truncate font-mono text-[11px] tracking-[0.03em] text-mute">
                {schedule.name}
              </div>
            ) : null}
          </div>
          <button
            aria-label={t("modal.cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("modal.nameLabel")}</span>
            <input
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("modal.taskLabel")}</span>
            {isCreate ? (
              <select
                className={inputClass}
                disabled={busy}
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              >
                <option value="">{t("modal.taskPlaceholder")}</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title} ({task.status})
                  </option>
                ))}
              </select>
            ) : (
              <select disabled className={inputClass} value={schedule.taskId}>
                <option value={schedule.taskId}>
                  {schedule.taskTitle ?? schedule.taskId}
                </option>
              </select>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("modal.cronLabel")}</span>
            <input
              className={inputClass}
              disabled={busy}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("modal.timezoneLabel")}</span>
              <select
                className={inputClass}
                disabled={busy}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {Intl.supportedValuesOf("timeZone").map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("modal.runnerLabel")}</span>
              <select
                className={inputClass}
                disabled={busy}
                value={runnerId ?? ""}
                onChange={(e) => setRunnerId(e.target.value || null)}
              >
                <option value="">{t("modal.runnerDefault")}</option>
                {runnerOptions.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.model
                      ? `${runner.id} · ${runner.model}`
                      : runner.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("modal.overlapLabel")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={overlapPolicy}
              onChange={(e) =>
                setOverlapPolicy(e.target.value as RunScheduleOverlapPolicy)
              }
            >
              {OVERLAP_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`overlap.${policy}`)}
                </option>
              ))}
            </select>
            <span className="font-mono text-[10px] text-mute">
              {t(`modal.overlapHint.${overlapPolicy}`)}
            </span>
          </label>

          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={enabled}
              disabled={busy}
              type="checkbox"
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("modal.enabledLabel")}
          </label>

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
          <div className="flex items-center gap-2">
            {!isCreate && !confirmingDelete ? (
              <button
                className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-danger hover:border-danger"
                disabled={busy}
                type="button"
                onClick={() => setConfirmingDelete(true)}
              >
                {t("modal.delete")}
              </button>
            ) : null}
            {!isCreate && confirmingDelete ? (
              <>
                <span className="font-mono text-[11px] font-semibold text-danger">
                  {t("modal.deleteConfirm")}
                </span>
                <button
                  className="touch-manipulation rounded-lg border border-danger bg-paper px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-danger hover:bg-danger-soft"
                  disabled={busy}
                  type="button"
                  onClick={() => void remove()}
                >
                  {t("modal.deleteConfirmYes")}
                </button>
                <button
                  className="touch-manipulation rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
                  disabled={busy}
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t("modal.deleteConfirmNo")}
                </button>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              {t("modal.cancel")}
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
              {busy ? t("modal.saving") : t("modal.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
