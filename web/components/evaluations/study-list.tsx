"use client";

import type { ReactElement } from "react";

import { BeakerIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { evalErrorKey, evalRequest } from "@/components/evaluations/api-error";
import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";

export interface StudySummary {
  id: string;
  title: string;
  status: string;
  taskId: string;
  updatedAt: string | null;
  legacyExperimentId: string | null;
}

export interface TaskOption {
  id: string;
  title: string;
  number: number;
}

type Props = {
  slug: string;
  studies: StudySummary[];
  tasks: TaskOption[];
  canManage: boolean;
};

const STATUS_TONE: Record<string, string> = {
  draft: "text-mute",
  open: "text-good",
  decided: "text-ink",
  archived: "text-mute",
};

export function StudyList({
  slug,
  studies,
  tasks,
  canManage,
}: Props): ReactElement {
  const t = useTranslations("evaluationsLab");
  const tErr = useTranslations("evaluationsErrors");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  function requestClose(): void {
    if (!saving) setCreating(false);
  }

  useModalFocusTrap(dialogRef, requestClose, creating);

  async function create(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await evalRequest(
        `/api/projects/${slug}/evaluations/studies`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            taskId,
            title: title.trim(),
            purpose: purpose.trim() || null,
          }),
        },
      );

      const { study } = (await res.json()) as { study: { id: string } };

      setCreating(false);
      startTransition(() =>
        router.push(`/projects/${slug}/evaluations/${study.id}`),
      );
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-[20px] font-semibold text-ink">
            {t("title")}
          </h1>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.5] text-mute">
            {t("listIntro")}
          </p>
        </div>
        {canManage ? (
          <button
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-3 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={tasks.length === 0}
            title={tasks.length === 0 ? t("noTasks") : undefined}
            type="button"
            onClick={() => setCreating(true)}
          >
            <PlusIcon aria-hidden="true" className="h-4 w-4" />
            {t("newStudy")}
          </button>
        ) : null}
      </div>

      {studies.length === 0 ? (
        <div className="grid place-items-center rounded-[12px] border border-dashed border-line py-16 text-center">
          <BeakerIcon aria-hidden="true" className="h-8 w-8 text-mute" />
          <p className="mt-3 text-[13px] text-mute">{t("noStudies")}</p>
        </div>
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {studies.map((study) => (
            <li key={study.id}>
              <Link
                className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-paper px-4 py-3 hover:border-mute"
                href={`/projects/${slug}/evaluations/${study.id}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-ink">
                    {study.title}
                  </span>
                  {study.legacyExperimentId ? (
                    <span className="mt-0.5 inline-block rounded-[4px] bg-ivory px-1.5 py-0.5 font-mono text-[10px] text-mute">
                      {t("migratedBadge")}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] ${
                    STATUS_TONE[study.status] ?? "text-mute"
                  }`}
                >
                  {t(`status_${study.status}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-50 grid place-items-center p-4">
              <button
                aria-label={t("close")}
                className="absolute inset-0 cursor-default bg-black/40"
                disabled={saving}
                tabIndex={-1}
                type="button"
                onClick={requestClose}
              />
              <div
                ref={dialogRef}
                aria-labelledby="create-study-title"
                aria-modal="true"
                className="relative w-full max-w-[520px] rounded-[12px] border border-line bg-paper p-6 shadow-xl"
                role="dialog"
              >
                <div className="mb-4 flex items-center justify-between">
                  <h2
                    className="m-0 text-[15px] font-semibold text-ink"
                    id="create-study-title"
                  >
                    {t("newStudy")}
                  </h2>
                  <button
                    aria-label={t("close")}
                    className="grid h-8 w-8 place-items-center rounded-[8px] text-mute hover:text-ink disabled:opacity-50"
                    disabled={saving}
                    type="button"
                    onClick={requestClose}
                  >
                    <XMarkIcon aria-hidden="true" className="h-5 w-5" />
                  </button>
                </div>

                <label className="mb-4 flex flex-col gap-1.5">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("studyTitle")}
                  </span>
                  <input
                    className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>

                <label className="mb-4 flex flex-col gap-1.5">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("studyTask")}
                  </span>
                  <select
                    className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
                    value={taskId}
                    onChange={(e) => setTaskId(e.target.value)}
                  >
                    {tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        #{task.number} · {task.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mb-4 flex flex-col gap-1.5">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {t("studyPurpose")}
                  </span>
                  <textarea
                    className="min-h-[64px] rounded-[8px] border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                  />
                </label>

                {error ? (
                  <p className="mb-3 text-[12px] text-danger" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className="flex justify-end gap-2">
                  <button
                    className="h-10 rounded-[8px] border border-line px-4 text-[13px] font-semibold text-ink disabled:opacity-50"
                    disabled={saving}
                    type="button"
                    onClick={requestClose}
                  >
                    {t("cancel")}
                  </button>
                  <button
                    className="h-10 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
                    disabled={saving || title.trim().length === 0 || !taskId}
                    type="button"
                    onClick={() => void create()}
                  >
                    {t("create")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
