"use client";
import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export function TaskQualificationSettingsControl({
  slug,
  baseline,
  override,
}: {
  slug: string;
  baseline: "legacy" | "required";
  override: "legacy" | "required" | null;
}): ReactElement {
  const t = useTranslations("taskQualification");
  const router = useRouter();
  const [choice, setChoice] = useState(override ?? "inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/projects/${slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskQualificationPolicy: choice === "inherit" ? null : choice,
        }),
      });

      if (!response.ok) {
        setError(t(response.status === 403 ? "permission" : "saveError"));

        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError(t("saveError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="font-semibold">{t("policyTitle")}</h3>
      <p className="text-sm text-mute">{t("policyHint")}</p>
      <label className="block text-sm">
        {t("policyTitle")}
        <select
          className="ml-2 rounded-lg border border-line bg-paper p-2"
          disabled={busy}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="inherit">
            {t("inherit", { baseline: t(`mode.${baseline}`) })}
          </option>
          <option value="required">{t("mode.required")}</option>
          <option value="legacy">{t("mode.legacy")}</option>
        </select>
      </label>
      <button
        className="rounded-lg border border-line px-3 py-2 text-sm"
        disabled={busy}
        type="button"
        onClick={() => void save()}
      >
        {t("savePolicy")}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {saved ? <p role="status">{t("saved")}</p> : null}
    </section>
  );
}
