"use client";

import type { ReactElement } from "react";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { updateProfile } from "@/app/(app)/account/actions";

export interface ProfileFormProps {
  name: string;
  email: string;
}

export function ProfileForm({ name, email }: ProfileFormProps): ReactElement {
  const t = useTranslations("account");
  const [state, formAction, pending] = useActionState(updateProfile, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("displayName")}
        </span>
        <input
          required
          autoComplete="name"
          className="rounded-[10px] border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]"
          defaultValue={name}
          maxLength={120}
          name="name"
          type="text"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("email")}
        </span>
        <input
          readOnly
          autoComplete="email"
          className="rounded-[10px] border border-line bg-ivory px-4 py-3 text-sm text-mute outline-none"
          type="email"
          value={email}
        />
      </label>

      <StatusMessage
        errorText={state?.status === "error" ? t("profileError") : undefined}
        successText={state?.status === "saved" ? t("profileSaved") : undefined}
      />

      <button
        className="w-max rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:-translate-y-px hover:bg-amber-2 disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? t("saving") : t("saveProfile")}
      </button>
    </form>
  );
}

function StatusMessage({
  errorText,
  successText,
}: {
  errorText?: string;
  successText?: string;
}): ReactElement | null {
  if (errorText) {
    return <p className="text-[12.5px] text-[#d9534f]">{errorText}</p>;
  }

  if (successText) {
    return <p className="text-[12.5px] text-good">{successText}</p>;
  }

  return null;
}
