"use client";

import type { SchedulerJobRow } from "@/components/admin/scheduler-jobs-table";
import type { SchedulerJobKind } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  CREATABLE_SCHEDULER_JOB_KINDS,
  isSeededSingletonSchedulerJob,
} from "@/lib/scheduler/job-catalog";
import {
  normalizeSchedulerTargetDraft,
  type SchedulerCommandKind,
} from "@/lib/scheduler/job-targets";

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

export type CreateSchedulerJobMutationBody = {
  cadenceIntervalSeconds: number;
  id?: string;
  jobKind: SchedulerJobKind;
  maxFailures: number;
  target: Record<string, unknown>;
};

export type UpdateSchedulerJobMutationBody = {
  cadenceIntervalSeconds: number;
  enabled: boolean;
  maxFailures: number;
  target?: Record<string, unknown>;
};

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
  const [commandKind, setCommandKind] = useState<SchedulerCommandKind>(
    job?.target.commandKind === "console_ping" ? "console_ping" : "http_ping",
  );
  const [commandUrl, setCommandUrl] = useState(
    typeof job?.target.url === "string" ? job.target.url : "",
  );
  const [commandHost, setCommandHost] = useState(
    typeof job?.target.host === "string" ? job.target.host : "",
  );
  const [commandTimeoutMs, setCommandTimeoutMs] = useState(
    typeof job?.target.timeoutMs === "number"
      ? String(job.target.timeoutMs)
      : "",
  );
  const [flowTaskId, setFlowTaskId] = useState(
    typeof job?.target.taskId === "string" ? job.target.taskId : "",
  );
  const [flowRunnerId, setFlowRunnerId] = useState(
    typeof job?.target.runnerId === "string" ? job.target.runnerId : "",
  );
  const [flowBaseBranch, setFlowBaseBranch] = useState(
    typeof job?.target.baseBranch === "string" ? job.target.baseBranch : "",
  );
  const [flowTargetBranch, setFlowTargetBranch] = useState(
    typeof job?.target.targetBranch === "string" ? job.target.targetBranch : "",
  );
  const [enabled, setEnabled] = useState(job ? job.disabledAt === null : true);
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

  function buildTarget(): Record<string, unknown> | null {
    try {
      return normalizeSchedulerTargetDraft({
        jobKind,
        draft: buildTargetDraft({
          commandHost,
          commandKind,
          commandTimeoutMs,
          commandUrl,
          flowBaseBranch,
          flowRunnerId,
          flowTargetBranch,
          flowTaskId,
          jobKind,
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));

      return null;
    }
  }

  async function save(): Promise<void> {
    setError(null);

    const shouldSendTarget =
      isCreate || jobKind === "command" || jobKind === "flow_run";
    const target = shouldSendTarget ? buildTarget() : undefined;

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
            body: JSON.stringify(
              buildCreateSchedulerJobMutationBody({
                cadenceIntervalSeconds: cadenceNum,
                id,
                jobKind,
                maxFailures: maxFailuresNum,
                target: target ?? {},
              }),
            ),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        : await fetch(`/api/admin/scheduler-jobs/${job.id}`, {
            body: JSON.stringify(
              buildUpdateSchedulerJobMutationBody({
                cadenceIntervalSeconds: cadenceNum,
                enabled,
                maxFailures: maxFailuresNum,
                target,
              }),
            ),
            headers: { "content-type": "application/json" },
            method: "PATCH",
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

  const canDelete =
    job !== null &&
    !isSeededSingletonSchedulerJob({ id: job.id, jobKind: job.jobKind });

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
                  {CREATABLE_SCHEDULER_JOB_KINDS.map((kind) => (
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

          <div className="flex flex-col gap-3">
            <span className={fieldLabel}>{t("targetLabel")}</span>
            {jobKind === "command" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>
                    {t("target.commandKindLabel")}
                  </span>
                  <select
                    className={inputClass}
                    disabled={busy}
                    value={commandKind}
                    onChange={(e) =>
                      setCommandKind(e.target.value as SchedulerCommandKind)
                    }
                  >
                    <option value="http_ping">{t("target.httpPing")}</option>
                    <option value="console_ping">
                      {t("target.consolePing")}
                    </option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>
                    {t("target.timeoutMsLabel")}
                  </span>
                  <input
                    className={inputClass}
                    disabled={busy}
                    inputMode="numeric"
                    placeholder="5000"
                    value={commandTimeoutMs}
                    onChange={(e) => setCommandTimeoutMs(e.target.value)}
                  />
                </label>
                {commandKind === "http_ping" ? (
                  <label className="col-span-2 flex flex-col gap-1.5">
                    <span className={fieldLabel}>{t("target.urlLabel")}</span>
                    <input
                      className={inputClass}
                      disabled={busy}
                      placeholder="https://example.com/healthz"
                      spellCheck={false}
                      value={commandUrl}
                      onChange={(e) => setCommandUrl(e.target.value)}
                    />
                  </label>
                ) : (
                  <label className="col-span-2 flex flex-col gap-1.5">
                    <span className={fieldLabel}>{t("target.hostLabel")}</span>
                    <input
                      className={inputClass}
                      disabled={busy}
                      placeholder="example.com"
                      spellCheck={false}
                      value={commandHost}
                      onChange={(e) => setCommandHost(e.target.value)}
                    />
                  </label>
                )}
              </div>
            ) : null}
            {jobKind === "flow_run" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span className={fieldLabel}>{t("target.taskIdLabel")}</span>
                  <input
                    className={inputClass}
                    disabled={busy}
                    placeholder="task-id"
                    spellCheck={false}
                    value={flowTaskId}
                    onChange={(e) => setFlowTaskId(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>
                    {t("target.runnerIdLabel")}
                  </span>
                  <input
                    className={inputClass}
                    disabled={busy}
                    placeholder="codex-default"
                    spellCheck={false}
                    value={flowRunnerId}
                    onChange={(e) => setFlowRunnerId(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>
                    {t("target.baseBranchLabel")}
                  </span>
                  <input
                    className={inputClass}
                    disabled={busy}
                    placeholder="main"
                    spellCheck={false}
                    value={flowBaseBranch}
                    onChange={(e) => setFlowBaseBranch(e.target.value)}
                  />
                </label>
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span className={fieldLabel}>
                    {t("target.targetBranchLabel")}
                  </span>
                  <input
                    className={inputClass}
                    disabled={busy}
                    placeholder="feature/scheduler"
                    spellCheck={false}
                    value={flowTargetBranch}
                    onChange={(e) => setFlowTargetBranch(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {jobKind !== "command" && jobKind !== "flow_run" ? (
              <div className="rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[11px] text-mute">
                {t("target.noTarget")}
              </div>
            ) : null}
          </div>

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
          <div className="flex items-center gap-2">
            {canDelete && !confirmingDelete ? (
              <button
                className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-danger hover:border-danger"
                disabled={busy}
                type="button"
                onClick={() => setConfirmingDelete(true)}
              >
                {t("delete")}
              </button>
            ) : null}
            {canDelete && confirmingDelete ? (
              <>
                <span className="font-mono text-[11px] font-semibold text-danger">
                  {t("deleteConfirm")}
                </span>
                <button
                  className="touch-manipulation rounded-lg border border-danger bg-paper px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-danger hover:bg-danger-soft"
                  disabled={busy}
                  type="button"
                  onClick={() => void remove()}
                >
                  {t("deleteConfirmYes")}
                </button>
                <button
                  className="touch-manipulation rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
                  disabled={busy}
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t("deleteConfirmNo")}
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

export function buildCreateSchedulerJobMutationBody(args: {
  cadenceIntervalSeconds: number;
  id: string;
  jobKind: SchedulerJobKind;
  maxFailures: number;
  target: Record<string, unknown>;
}): CreateSchedulerJobMutationBody {
  return {
    cadenceIntervalSeconds: args.cadenceIntervalSeconds,
    id: args.id.trim() || undefined,
    jobKind: args.jobKind,
    maxFailures: args.maxFailures,
    target: args.target,
  };
}

export function buildUpdateSchedulerJobMutationBody(args: {
  cadenceIntervalSeconds: number;
  enabled: boolean;
  maxFailures: number;
  target?: Record<string, unknown>;
}): UpdateSchedulerJobMutationBody {
  return {
    cadenceIntervalSeconds: args.cadenceIntervalSeconds,
    enabled: args.enabled,
    maxFailures: args.maxFailures,
    ...(args.target === undefined ? {} : { target: args.target }),
  };
}

function buildTargetDraft(args: {
  commandHost: string;
  commandKind: SchedulerCommandKind;
  commandTimeoutMs: string;
  commandUrl: string;
  flowBaseBranch: string;
  flowRunnerId: string;
  flowTargetBranch: string;
  flowTaskId: string;
  jobKind: SchedulerJobKind;
}): Record<string, unknown> {
  if (args.jobKind === "command") {
    return args.commandKind === "http_ping"
      ? {
          commandKind: args.commandKind,
          timeoutMs: args.commandTimeoutMs,
          url: args.commandUrl,
        }
      : {
          commandKind: args.commandKind,
          host: args.commandHost,
          timeoutMs: args.commandTimeoutMs,
        };
  }

  if (args.jobKind === "flow_run") {
    return {
      baseBranch: args.flowBaseBranch,
      runnerId: args.flowRunnerId,
      targetBranch: args.flowTargetBranch,
      taskId: args.flowTaskId,
    };
  }

  return {};
}
