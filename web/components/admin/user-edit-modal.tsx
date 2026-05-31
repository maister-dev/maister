"use client";

import type { AdminUserRow } from "@/components/admin/users-table";
import type { AccountStatus, GlobalRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

export interface UserEditModalProps {
  user: AdminUserRow;
  onClose: () => void;
  onSaved: () => void;
}

export function UserEditModal({
  user,
  onClose,
  onSaved,
}: UserEditModalProps): ReactElement {
  const t = useTranslations("adminUsers");
  const [role, setRole] = useState<GlobalRole>(user.role);
  const [status, setStatus] = useState<AccountStatus>(user.status);
  const [password, setPassword] = useState("");
  const [forceChange, setForceChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const passwordTooShort = password.length > 0 && password.length < 12;
  const dirty =
    role !== user.role ||
    (status !== user.status && status !== "pending") ||
    password.length >= 12;

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

  async function save(): Promise<void> {
    const patch: Record<string, unknown> = {};

    if (role !== user.role) patch.role = role;
    if (status !== user.status && status !== "pending") patch.status = status;

    if (password.length >= 12) {
      patch.password = password;
      patch.mustChangePassword = forceChange;
    }

    if (Object.keys(patch).length === 0) {
      onClose();

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
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
        aria-labelledby="user-edit-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2
              className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
              id="user-edit-title"
            >
              {t("editTitle")}
            </h2>
            <div className="mt-1 truncate text-[13px] font-semibold text-ink">
              {user.name ?? user.email}
            </div>
            <div className="truncate font-mono text-[10.5px] tracking-[0.03em] text-mute">
              {user.email}
            </div>
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
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("roleLabel")}</span>
              <select
                className={inputClass}
                disabled={busy}
                value={role}
                onChange={(e) => setRole(e.target.value as GlobalRole)}
              >
                <option value="viewer">{t("role.viewer")}</option>
                <option value="member">{t("role.member")}</option>
                <option value="admin">{t("role.admin")}</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("statusLabel")}</span>
              <select
                className={inputClass}
                disabled={busy}
                value={status}
                onChange={(e) => setStatus(e.target.value as AccountStatus)}
              >
                {user.status === "pending" ? (
                  <option value="pending">{t("status.pending")}</option>
                ) : null}
                <option value="active">{t("status.active")}</option>
                <option value="disabled">{t("status.disabled")}</option>
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-line bg-ivory/40 px-3.5 py-3">
            <span className={fieldLabel}>{t("resetPassword")}</span>
            <input
              aria-label={t("resetPassword")}
              autoComplete="new-password"
              className={inputClass}
              minLength={12}
              name="new-password"
              placeholder={t("passwordPlaceholder")}
              spellCheck={false}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {passwordTooShort ? (
              <span className="font-mono text-[10.5px] text-[#b5332b]">
                {t("passwordHint")}
              </span>
            ) : null}
            <label className="flex items-center gap-2 text-[12px] text-mute">
              <input
                checked={forceChange}
                disabled={password.length === 0}
                type="checkbox"
                onChange={(e) => setForceChange(e.target.checked)}
              />
              {t("forceChange")}
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("projectAccess")}</span>
            {user.projects.length === 0 ? (
              <span className="font-mono text-[11px] text-mute">
                {t("noProjectAccess")}
              </span>
            ) : (
              <ul className="flex list-none flex-col gap-1">
                {user.projects.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between rounded-md border border-line bg-paper px-3 py-1.5"
                  >
                    <code className="truncate font-mono text-[11.5px] text-ink">
                      {p.name}
                    </code>
                    <span className="ml-3 shrink-0 rounded-full border border-line bg-ivory px-2 py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
                      {p.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

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

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
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
              (busy || passwordTooShort || !dirty) && "opacity-60",
            )}
            disabled={busy || passwordTooShort || !dirty}
            type="button"
            onClick={() => void save()}
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
