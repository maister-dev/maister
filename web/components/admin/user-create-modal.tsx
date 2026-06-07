"use client";

import type { GlobalRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

// Generates a cryptographically random password client-side.
// 20 chars from a mixed set: uppercase, lowercase, digits, symbols.
function generatePassword(): string {
  const charset =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(20));

  return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

export interface UserCreateModalProps {
  onClose: () => void;
  onSaved: () => void;
}

export function UserCreateModal({
  onClose,
  onSaved,
}: UserCreateModalProps): ReactElement {
  const t = useTranslations("adminUsers");
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<GlobalRole>("member");
  const [status, setStatus] = useState<"active" | "pending">("active");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const passwordTooShort = password.length > 0 && password.length < 12;
  const canSubmit =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    !passwordTooShort &&
    !busy;

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

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        email: email.trim(),
        role,
        status,
      };

      if (password.length >= 12) body.password = password;

      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        setError(
          parsed?.message ?? parsed?.code ?? `Request failed: ${res.status}`,
        );

        return;
      }

      const data = (await res.json()) as { id: string; tempPassword: string };

      setTempPassword(data.tempPassword);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!tempPassword) return;

    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — value is still selectable in the code block.
    }
  }

  function handleClose(): void {
    if (tempPassword) {
      router.refresh();
    }

    onClose();
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("cancel")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={handleClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="user-create-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="user-create-title"
          >
            {t("createTitle")}
          </h2>
          <button
            aria-label={t("cancel")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={handleClose}
          >
            ✕
          </button>
        </div>

        {tempPassword !== null ? (
          <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
            <div
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {t("tempPasswordOnce")}
            </div>
            <code className="block break-all rounded-lg border border-line bg-ivory px-3 py-2.5 font-mono text-[12px] text-ink">
              {tempPassword}
            </code>
            <button
              className="self-start rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
              type="button"
              onClick={() => void copy()}
            >
              {copied ? t("copied") : t("copy")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("name")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  placeholder="Alice Smith"
                  spellCheck={false}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label className="col-span-2 flex flex-col gap-1.5">
                <span className={fieldLabel}>{t("email")}</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  placeholder="alice@example.com"
                  spellCheck={false}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

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
                  onChange={(e) =>
                    setStatus(e.target.value as "active" | "pending")
                  }
                >
                  <option value="active">{t("status.active")}</option>
                  <option value="pending">{t("status.pending")}</option>
                </select>
              </label>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-line bg-ivory/40 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <span className={fieldLabel}>{t("tempPassword")}</span>
                <button
                  className="rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.03em] text-mute hover:border-mute hover:text-ink-2"
                  disabled={busy}
                  type="button"
                  onClick={() => setPassword(generatePassword())}
                >
                  {t("generatePassword")}
                </button>
              </div>
              <input
                aria-label={t("tempPassword")}
                autoComplete="new-password"
                className={inputClass}
                disabled={busy}
                minLength={12}
                name="create-password"
                placeholder={t("passwordPlaceholder")}
                spellCheck={false}
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {passwordTooShort ? (
                <span className="font-mono text-[10.5px] text-[#b5332b]">
                  {t("passwordHint")}
                </span>
              ) : (
                <span className="font-mono text-[10px] text-mute">
                  {t("passwordBlankHint")}
                </span>
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
        )}

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          {tempPassword !== null ? (
            <button
              className="touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
              type="button"
              onClick={handleClose}
            >
              {t("cancel")}
            </button>
          ) : (
            <>
              <button
                className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
                disabled={busy}
                type="button"
                onClick={handleClose}
              >
                {t("cancel")}
              </button>
              <button
                className={clsx(
                  "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
                  (!canSubmit || busy) && "opacity-60",
                )}
                disabled={!canSubmit || busy}
                type="button"
                onClick={() => void submit()}
              >
                {busy ? t("saving") : t("newUser")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
