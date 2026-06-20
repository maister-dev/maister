"use client";

import type { SidecarDraft } from "@/lib/acp-runners/sidecar-form";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  buildCreateBody,
  buildPatchBody,
  emptySidecarDraft,
  validateSidecarDraft,
} from "@/lib/acp-runners/sidecar-form";

export interface SidecarRow {
  id: string;
  lifecycle: "managed" | "external";
  configPath: string | null;
  baseUrl: string | null;
  healthcheckUrl: string | null;
  authTokenRef: string | null;
  enabled: boolean;
}

export interface SidecarModalProps {
  mode: "create" | "edit";
  sidecar?: SidecarRow;
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

function seedDraft(
  mode: "create" | "edit",
  sidecar?: SidecarRow,
): SidecarDraft {
  if (mode === "edit" && sidecar) {
    return {
      id: sidecar.id,
      lifecycle: sidecar.lifecycle,
      configPath: sidecar.configPath ?? undefined,
      baseUrl: sidecar.baseUrl ?? undefined,
      healthcheckUrl: sidecar.healthcheckUrl ?? undefined,
      authTokenRef: sidecar.authTokenRef ?? undefined,
      enabled: sidecar.enabled,
    };
  }

  return emptySidecarDraft();
}

async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;

    return {
      ok: false,
      code: payload?.code,
      message:
        payload?.message ?? payload?.code ?? `Request failed: ${res.status}`,
    };
  }

  return { ok: true };
}

export function SidecarModal({
  mode,
  sidecar,
  onClose,
  onSaved,
}: SidecarModalProps): ReactElement {
  const t = useTranslations("settings");
  const [draft, setDraft] = useState<SidecarDraft>(() =>
    seedDraft(mode, sidecar),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const originalDraft = useRef<SidecarDraft>(seedDraft(mode, sidecar));
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

  const { ok, errors } = validateSidecarDraft(draft);

  function patchDraft(patch: Partial<SidecarDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function errorFor(field: string): string | undefined {
    if (!errors[field]) return undefined;
    if (field === "id") return t("validId");
    if (field === "baseUrl" || field === "healthcheckUrl") return t("validUrl");
    if (field === "authTokenRef") return t("validEnvRef");
    if (field === "configPath") return t("validConfigPath");

    return errors[field];
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const result =
        mode === "create"
          ? await sendJson(
              "/api/admin/router-sidecars",
              "POST",
              buildCreateBody(draft),
            )
          : await sendJson(
              `/api/admin/router-sidecars/${sidecar?.id ?? ""}`,
              "PATCH",
              buildPatchBody(draft, originalDraft.current),
            );

      if (!result.ok) {
        setError(`${t("saveFailed")}: ${result.message ?? ""}`);

        return;
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(
        `${t("saveFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!confirmingDelete) {
      setConfirmingDelete(true);

      return;
    }

    setBusy(true);
    setError(null);
    setDeleteBlocked(false);

    try {
      const res = await fetch(
        `/api/admin/router-sidecars/${sidecar?.id ?? ""}`,
        { method: "DELETE" },
      );

      if (res.status === 204) {
        onSaved();
        onClose();

        return;
      }

      const payload = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (payload?.code === "CONFLICT") {
        setDeleteBlocked(true);
        setError(payload.message ?? "");
      } else {
        setError(payload?.message ?? `Request failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="sidecar-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="sidecar-modal-title"
          >
            {mode === "create"
              ? t("createSidecarTitle")
              : t("editSidecarTitle")}
          </h2>
          <button
            aria-label="Close"
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("sidecarId")}</span>
            {mode === "create" ? (
              <input
                autoComplete="off"
                className={inputClass}
                disabled={busy}
                spellCheck={false}
                type="text"
                value={draft.id}
                onChange={(e) => patchDraft({ id: e.target.value })}
              />
            ) : (
              <code className="font-mono text-[12px] text-ink">{draft.id}</code>
            )}
            {errorFor("id") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("id")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("lifecycle")}</span>
            <select
              className={inputClass}
              disabled={busy}
              value={draft.lifecycle}
              onChange={(e) =>
                patchDraft({
                  lifecycle: e.target.value as SidecarDraft["lifecycle"],
                })
              }
            >
              <option value="managed">managed</option>
              <option value="external">external</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("configPath")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              type="text"
              value={draft.configPath ?? ""}
              onChange={(e) =>
                patchDraft({ configPath: e.target.value || undefined })
              }
            />
            {errorFor("configPath") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("configPath")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("baseUrl")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              type="text"
              value={draft.baseUrl ?? ""}
              onChange={(e) =>
                patchDraft({ baseUrl: e.target.value || undefined })
              }
            />
            {errorFor("baseUrl") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("baseUrl")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("healthcheckUrl")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              type="text"
              value={draft.healthcheckUrl ?? ""}
              onChange={(e) =>
                patchDraft({ healthcheckUrl: e.target.value || undefined })
              }
            />
            {errorFor("healthcheckUrl") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("healthcheckUrl")}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("authTokenRef")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              spellCheck={false}
              type="text"
              value={draft.authTokenRef ?? ""}
              onChange={(e) =>
                patchDraft({ authTokenRef: e.target.value || undefined })
              }
            />
            {errorFor("authTokenRef") ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {errorFor("authTokenRef")}
              </span>
            ) : null}
          </label>

          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={draft.enabled}
              disabled={busy}
              type="checkbox"
              onChange={(e) => patchDraft({ enabled: e.target.checked })}
            />
            {t("fieldEnabled")}
          </label>

          {error ? (
            <div
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {deleteBlocked ? (
                <div className="mb-1.5 flex flex-col gap-1">
                  <span>{t("deleteSidecarBlockedTitle")}</span>
                  <span className="font-normal">
                    {t("deleteSidecarBlockedIntro")}
                  </span>
                </div>
              ) : null}
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
          <div>
            {mode === "edit" ? (
              <button
                className="touch-manipulation rounded-lg border border-[#b5332b]/40 bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-[#b5332b] hover:border-[#b5332b] hover:bg-[#b5332b]/5"
                disabled={busy}
                title={confirmingDelete ? t("deleteSidecarConfirm") : undefined}
                type="button"
                onClick={() => void remove()}
              >
                {confirmingDelete
                  ? t("deleteSidecarConfirm")
                  : t("deleteSidecar")}
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
                (busy || !ok) && "opacity-60",
              )}
              disabled={busy || !ok}
              type="button"
              onClick={() => void submit()}
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
