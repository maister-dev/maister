"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/taxonomy";

export type WebhookMethod = "POST" | "PUT";

const METHODS: readonly WebhookMethod[] = ["POST", "PUT"];

// All selectable event-type options for the multiselect: the canonical taxonomy
// plus the "*" wildcard (every event). NO secret value is ever part of this set.
const EVENT_TYPE_OPTIONS: readonly string[] = ["*", ...WEBHOOK_EVENT_TYPES];

// The modal's view of one subscription. There is intentionally NO raw secret
// value field here — only `env:NAME` REFERENCE strings — so a plaintext secret
// can never be typed into, rendered by, or submitted from this form.
export interface SubscriptionModalValue {
  name: string;
  url: string;
  method: WebhookMethod;
  headers: Record<string, string>;
  event_types: string[];
  signing_secret_ref: string;
  secondary_signing_secret_ref: string | null;
  enabled: boolean;
}

export interface SubscriptionModalProps {
  open: boolean;
  mode: "create" | "edit";
  initial?: SubscriptionModalValue;
  onSubmit: (value: SubscriptionModalValue) => void;
  onClose: () => void;
}

interface HeaderRow {
  key: string;
  value: string;
}

type FormState = {
  name: string;
  url: string;
  method: WebhookMethod;
  headers: HeaderRow[];
  eventTypes: string[];
  signingSecretRef: string;
  secondarySigningSecretRef: string;
  enabled: boolean;
};

const inputClass =
  "min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

function seedForm(
  mode: "create" | "edit",
  initial?: SubscriptionModalValue,
): FormState {
  if (mode === "edit" && initial) {
    return {
      name: initial.name,
      url: initial.url,
      method: initial.method,
      headers: Object.entries(initial.headers).map(([key, value]) => ({
        key,
        value,
      })),
      eventTypes: [...initial.event_types],
      signingSecretRef: initial.signing_secret_ref,
      secondarySigningSecretRef: initial.secondary_signing_secret_ref ?? "",
      enabled: initial.enabled,
    };
  }

  return {
    name: "",
    url: "",
    method: "POST",
    headers: [],
    eventTypes: [],
    signingSecretRef: "",
    secondarySigningSecretRef: "",
    enabled: true,
  };
}

function toValue(form: FormState): SubscriptionModalValue {
  const headers: Record<string, string> = {};

  for (const row of form.headers) {
    const key = row.key.trim();

    if (key) headers[key] = row.value;
  }

  const secondary = form.secondarySigningSecretRef.trim();

  return {
    name: form.name.trim(),
    url: form.url.trim(),
    method: form.method,
    headers,
    event_types: form.eventTypes,
    signing_secret_ref: form.signingSecretRef.trim(),
    secondary_signing_secret_ref: secondary || null,
    enabled: form.enabled,
  };
}

export function SubscriptionModal({
  open,
  mode,
  initial,
  onSubmit,
  onClose,
}: SubscriptionModalProps): ReactElement | null {
  const t = useTranslations("webhooks");
  const [form, setForm] = useState<FormState>(() => seedForm(mode, initial));

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

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
  }, [open]);

  if (!open) return null;

  const value = toValue(form);
  const canSubmit =
    value.name.length > 0 &&
    value.url.length > 0 &&
    value.signing_secret_ref.length > 0 &&
    value.event_types.length > 0;

  function patchForm(patch: Partial<FormState>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  function toggleEventType(type: string): void {
    setForm((current) => {
      const has = current.eventTypes.includes(type);

      return {
        ...current,
        eventTypes: has
          ? current.eventTypes.filter((eventType) => eventType !== type)
          : [...current.eventTypes, type],
      };
    });
  }

  function patchHeader(index: number, patch: Partial<HeaderRow>): void {
    setForm((current) => ({
      ...current,
      headers: current.headers.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  }

  function addHeader(): void {
    setForm((current) => ({
      ...current,
      headers: [...current.headers, { key: "", value: "" }],
    }));
  }

  function removeHeader(index: number): void {
    setForm((current) => ({
      ...current,
      headers: current.headers.filter((_, i) => i !== index),
    }));
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={t("close")}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="webhook-subscription-modal-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id="webhook-subscription-modal-title"
          >
            {mode === "create" ? t("createTitle") : t("editTitle")}
          </h2>
          <button
            aria-label={t("close")}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldName")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              spellCheck={false}
              type="text"
              value={form.name}
              onChange={(e) => patchForm({ name: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldUrl")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              placeholder="https://example.com/hooks"
              spellCheck={false}
              type="text"
              value={form.url}
              onChange={(e) => patchForm({ url: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldMethod")}</span>
            <select
              className={inputClass}
              value={form.method}
              onChange={(e) =>
                patchForm({ method: e.target.value as WebhookMethod })
              }
            >
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1.5 border-0 p-0">
            <span className={fieldLabel}>{t("fieldEventTypes")}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {EVENT_TYPE_OPTIONS.map((type) => (
                <label
                  key={type}
                  className="flex items-center gap-2 font-mono text-[11px] text-mute"
                >
                  <input
                    checked={form.eventTypes.includes(type)}
                    type="checkbox"
                    onChange={() => toggleEventType(type)}
                  />
                  {type === "*" ? t("allEvents") : type}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5 border-0 p-0">
            <span className={fieldLabel}>{t("fieldHeaders")}</span>
            <span className="font-mono text-[10px] text-mute">
              {t("headersHint")}
            </span>
            <div className="flex flex-col gap-2">
              {form.headers.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    aria-label={t("headerKeyLabel")}
                    autoComplete="off"
                    className={`${inputClass} flex-1`}
                    placeholder={t("headerKeyPlaceholder")}
                    spellCheck={false}
                    type="text"
                    value={row.key}
                    onChange={(e) =>
                      patchHeader(index, { key: e.target.value })
                    }
                  />
                  <input
                    aria-label={t("headerValueLabel")}
                    autoComplete="off"
                    className={`${inputClass} flex-1`}
                    placeholder="env:HOOK_TOKEN"
                    spellCheck={false}
                    type="text"
                    value={row.value}
                    onChange={(e) =>
                      patchHeader(index, { value: e.target.value })
                    }
                  />
                  <button
                    aria-label={t("removeHeader")}
                    className="font-mono text-[14px] text-mute hover:text-ink"
                    type="button"
                    onClick={() => removeHeader(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="self-start rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-[11px] font-semibold text-mute hover:border-mute hover:text-ink-2"
                type="button"
                onClick={addHeader}
              >
                {t("addHeader")}
              </button>
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>{t("fieldSigningSecretRef")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              placeholder="env:WEBHOOK_SIGNING_SECRET"
              spellCheck={false}
              type="text"
              value={form.signingSecretRef}
              onChange={(e) => patchForm({ signingSecretRef: e.target.value })}
            />
            <span className="font-mono text-[10px] text-mute">
              {t("secretRefHint")}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>
              {t("fieldSecondarySigningSecretRef")}
            </span>
            <input
              autoComplete="off"
              className={inputClass}
              placeholder="env:WEBHOOK_SIGNING_SECRET_NEXT"
              spellCheck={false}
              type="text"
              value={form.secondarySigningSecretRef}
              onChange={(e) =>
                patchForm({ secondarySigningSecretRef: e.target.value })
              }
            />
            <span className="font-mono text-[10px] text-mute">
              {t("secretRefHint")}
            </span>
          </label>

          <label className="flex items-center gap-2 text-[12px] text-mute">
            <input
              checked={form.enabled}
              type="checkbox"
              onChange={(e) => patchForm({ enabled: e.target.checked })}
            />
            {t("fieldEnabled")}
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="touch-manipulation rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
            type="button"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className={clsx(
              "touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
              !canSubmit && "opacity-60",
            )}
            disabled={!canSubmit}
            type="button"
            onClick={() => onSubmit(value)}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
