"use client";

import type { ScheduleDTO } from "@/lib/run-schedules/queries";
import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  ScheduleEditModal,
  type ScheduleTaskOption,
} from "@/components/schedules/schedule-edit-modal";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { readApiError } from "@/lib/api-error";

export type { ScheduleTaskOption };

type TriggerOutcome = {
  outcome: string;
  runId?: string;
  queuePosition?: number;
  errorCode?: string;
};

export interface SchedulesPanelProps {
  canManage: boolean;
  schedules: ScheduleDTO[];
  slug: string;
  tasks: ScheduleTaskOption[];
}

export function SchedulesPanel({
  canManage,
  schedules,
  slug,
  tasks,
}: SchedulesPanelProps): ReactElement {
  const t = useTranslations("projectSchedules");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduleDTO | null>(null);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggerOutcome, setTriggerOutcome] = useState<TriggerOutcome | null>(
    null,
  );

  const refresh = (): void => startTransition(() => router.refresh());

  async function toggleEnabled(schedule: ScheduleDTO): Promise<void> {
    setMutating(true);
    setError(null);
    setTriggerOutcome(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/schedules/${schedule.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !schedule.enabled }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }

  async function triggerNow(schedule: ScheduleDTO): Promise<void> {
    setMutating(true);
    setError(null);
    setTriggerOutcome(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/schedules/${schedule.id}/trigger`,
        { method: "POST" },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      setTriggerOutcome((await res.json()) as TriggerOutcome);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
            {t("title")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
            {t("sub")}
          </p>
        </div>
        {canManage ? (
          <button
            className="shrink-0 touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("create")}
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          aria-live="assertive"
          className="mb-3 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {triggerOutcome ? (
        <div
          aria-live="polite"
          className="mb-3 rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-semibold text-ink-2"
          role="status"
        >
          {t(`triggerOutcome.${triggerOutcome.outcome}`)}
          {triggerOutcome.runId ? ` · ${triggerOutcome.runId}` : ""}
          {triggerOutcome.queuePosition !== undefined
            ? ` · #${triggerOutcome.queuePosition}`
            : ""}
          {triggerOutcome.errorCode ? ` · ${triggerOutcome.errorCode}` : ""}
        </div>
      ) : null}

      <SchedulesTable
        busy={mutating || refreshing}
        canManage={canManage}
        schedules={schedules}
        onEdit={(schedule) => setEditing(schedule)}
        onToggleEnabled={(schedule) => void toggleEnabled(schedule)}
        onTrigger={(schedule) => void triggerNow(schedule)}
      />

      {creating ? (
        <ScheduleEditModal
          schedule={null}
          slug={slug}
          tasks={tasks}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
      {editing ? (
        <ScheduleEditModal
          schedule={editing}
          slug={slug}
          tasks={tasks}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}
