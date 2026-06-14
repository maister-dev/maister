"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export interface PackageSourceRow {
  id: string;
  url: string;
  enabled: boolean;
  note: string | null;
  discovered: Array<{ name: string; dir: string; tags: string[] }>;
  lastCheckedAt: string | null;
  builtIn: boolean;
}

export interface PackageSourceModalProps {
  mode: "create" | "edit";
  source?: PackageSourceRow;
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

async function sendJson(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;

    return {
      ok: false,
      message:
        payload?.message ?? payload?.code ?? `Request failed: ${res.status}`,
    };
  }

  return { ok: true };
}

export function PackageSourceModal({
  mode,
  source,
  onClose,
  onSaved,
}: PackageSourceModalProps): ReactElement {
  const t = useTranslations("settings");
  const [url, setUrl] = useState(source?.url ?? "");
  const [note, setNote] = useState(source?.note ?? "");
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
              'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
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

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);

    const result =
      mode === "create"
        ? await sendJson("/api/admin/package-sources", "POST", {
            url,
            ...(note ? { note } : {}),
            enabled,
          })
        : await sendJson(`/api/admin/package-sources/${source!.id}`, "PATCH", {
            enabled,
            note,
          });

    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "failed");

      return;
    }
    onSaved();
  }

  async function remove(): Promise<void> {
    if (!confirmingDelete) {
      setConfirmingDelete(true);

      return;
    }
    setBusy(true);
    setError(null);

    const result = await sendJson(
      `/api/admin/package-sources/${source!.id}`,
      "DELETE",
    );

    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "failed");
      setConfirmingDelete(false);

      return;
    }
    onSaved();
  }

  return (
    <div
      aria-labelledby="package-source-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-[520px] rounded-[16px] border border-line bg-paper p-6 shadow-xl"
      >
        <h3
          className="m-0 mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
          id="package-source-modal-title"
        >
          {mode === "create" ? t("pkgSourceAdd") : t("pkgSourceEdit")}
        </h3>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("pkgSourceUrl")}</span>
            <input
              className={inputClass}
              disabled={mode === "edit"}
              placeholder="github.com/org/maister-plugins"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("pkgSourceNote")}</span>
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              checked={enabled}
              type="checkbox"
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("pkgSourceEnabled")}
          </label>

          {error ? (
            <p className="m-0 text-[12px] text-red-600" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            {mode === "edit" ? (
              <button
                className="h-9 rounded-[8px] border border-red-500/40 px-3 text-[12.5px] font-semibold text-red-600 hover:bg-red-500/10"
                disabled={busy}
                type="button"
                onClick={remove}
              >
                {confirmingDelete ? t("pkgSourceDeleteConfirm") : t("delete")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                className="h-9 rounded-[8px] border border-line px-3 text-[12.5px] font-semibold text-ink hover:bg-ivory"
                disabled={busy}
                type="button"
                onClick={onClose}
              >
                {t("cancel")}
              </button>
              <button
                className="h-9 rounded-[8px] border border-amber bg-amber px-4 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
                disabled={busy || url.length === 0}
                type="button"
                onClick={save}
              >
                {t("save")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
