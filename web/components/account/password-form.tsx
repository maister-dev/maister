"use client";

import type { ReactElement } from "react";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { updateAccountPassword } from "@/app/(app)/account/actions";

export function AccountPasswordForm(): ReactElement {
  const t = useTranslations("account");
  const [state, formAction, pending] = useActionState(
    updateAccountPassword,
    undefined,
  );

  const errorKey =
    state?.status === "error" && state.error === "mismatch"
      ? "passwordMismatch"
      : state?.status === "error" && state.error === "weak"
        ? "passwordWeak"
        : state?.status === "error"
          ? "passwordError"
          : null;

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("newPassword")}
        </span>
        <input
          required
          autoComplete="new-password"
          className="rounded-[10px] border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]"
          minLength={12}
          name="password"
          type="password"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("confirmPassword")}
        </span>
        <input
          required
          autoComplete="new-password"
          className="rounded-[10px] border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]"
          minLength={12}
          name="confirm"
          type="password"
        />
      </label>

      <p className="text-[11.5px] leading-[1.5] text-mute">
        {t("passwordHint")}
      </p>

      {errorKey ? (
        <p className="text-[12.5px] text-[#d9534f]">{t(errorKey)}</p>
      ) : null}

      {state?.status === "saved" ? (
        <p className="text-[12.5px] text-good">{t("passwordSaved")}</p>
      ) : null}

      <button
        className="mt-1 w-max rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2 disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? t("saving") : t("changePassword")}
      </button>
    </form>
  );
}
