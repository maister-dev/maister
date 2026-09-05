"use client";

import type { JudgePanelRow, MethodologyRow, ProfileRow } from "./types";
import type { ReactElement } from "react";

import { XMarkIcon } from "@heroicons/react/24/outline";
import { useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { evalErrorKey, evalRequest } from "@/components/evaluations/api-error";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";

type Props = {
  mode: "create" | "edit";
  profile?: ProfileRow;
  methodologies: MethodologyRow[];
  panels: JudgePanelRow[];
  onClose: () => void;
};

// Method + Panel are IMMUTABLE after creation (patchProfileBodySchema forbids
// them) — a Profile pins a specific method revision + panel so historical
// executions stay reproducible. Edit changes only name / bounds / activation.
export function ProfileModal({
  mode,
  profile,
  methodologies,
  panels,
  onClose,
}: Props): ReactElement | null {
  const t = useTranslations("settingsEvaluations");
  const tErr = useTranslations("evaluationsErrors");
  const feedback = useFeedback();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const readyMethods = methodologies.filter((m) => m.health === "ready");
  const enabledPanels = panels.filter((p) => p.enabled);
  const [name, setName] = useState(profile?.name ?? "");
  const [methodRevisionId, setMethodRevisionId] = useState(
    profile?.methodRevisionId ?? readyMethods[0]?.id ?? "",
  );
  const [panelId, setPanelId] = useState(
    profile?.panelId ?? enabledPanels[0]?.id ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  function requestClose(): void {
    if (!saving) onClose();
  }

  useModalFocusTrap(dialogRef, requestClose);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        await evalRequest("/api/admin/evaluations/profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            methodRevisionId,
            panelId,
          }),
        });
      } else {
        await evalRequest(`/api/admin/evaluations/profiles/${profile!.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": String(profile!.revision),
          },
          body: JSON.stringify({ name: name.trim() }),
        });
      }

      feedback.success({
        mutationId: `eval-profile:${mode}:${profile?.id ?? "new"}:${Date.now()}`,
        message: t("toastSaved"),
      });
      startTransition(() => router.refresh());
      onClose();
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  const methodLabel = (id: string): string =>
    methodologies.find((m) => m.id === id)?.qualifiedId ?? id;
  const panelLabel = (id: string): string =>
    panels.find((p) => p.id === id)?.name ?? id;

  if (typeof document === "undefined") return null;

  return createPortal(
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
        aria-labelledby="profile-modal-title"
        aria-modal="true"
        className="relative w-full max-w-[520px] rounded-[12px] border border-line bg-paper p-6 shadow-xl"
        role="dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="m-0 text-[15px] font-semibold text-ink"
            id="profile-modal-title"
          >
            {mode === "create" ? t("profileCreate") : t("profileEdit")}
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
            {t("profileName")}
          </span>
          <input
            className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="mb-4 flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("profileMethod")}
          </span>
          {mode === "edit" ? (
            <span className="font-mono text-[12px] text-ink-2">
              {methodLabel(methodRevisionId)}
            </span>
          ) : (
            <select
              className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
              value={methodRevisionId}
              onChange={(e) => setMethodRevisionId(e.target.value)}
            >
              {readyMethods.length === 0 ? (
                <option value="">{t("noReadyMethods")}</option>
              ) : null}
              {readyMethods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.qualifiedId} · {m.versionLabel}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="mb-4 flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("profilePanel")}
          </span>
          {mode === "edit" ? (
            <span className="text-[12px] text-ink-2">
              {panelLabel(panelId)}
            </span>
          ) : (
            <select
              className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
              value={panelId}
              onChange={(e) => setPanelId(e.target.value)}
            >
              {enabledPanels.length === 0 ? (
                <option value="">{t("noEnabledPanels")}</option>
              ) : null}
              {enabledPanels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
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
            disabled={
              saving ||
              name.trim().length === 0 ||
              (mode === "create" && (!methodRevisionId || !panelId))
            }
            type="button"
            onClick={() => void save()}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
