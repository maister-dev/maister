"use client";

import type { ReactElement } from "react";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { changePassword } from "@/app/change-password/actions";

export function ChangePasswordForm(): ReactElement {
  const t = useTranslations("changePassword");
  const [state, formAction, pending] = useActionState(
    changePassword,
    undefined,
  );

  const errorKey =
    state?.error === "mismatch"
      ? "errorMismatch"
      : state?.error === "weak"
        ? "errorWeak"
        : state?.error
          ? "errorGeneric"
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
          {t("confirm")}
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

      <p className="text-[11.5px] leading-[1.5] text-mute">{t("hint")}</p>

      {errorKey ? (
        <p className="text-[12.5px] text-[#d9534f]">{t(errorKey)}</p>
      ) : null}

      <button
        className="mt-2 flex w-full items-center justify-center rounded-full bg-amber px-[22px] py-3.5 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2 disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {t("submit")}
      </button>
    </form>
  );
}
