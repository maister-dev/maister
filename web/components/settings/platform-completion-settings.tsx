"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

export function PlatformCompletionSettings({
  initial,
}: {
  initial: { enabled: boolean; revision: number };
}) {
  const t = useTranslations("completionSettings");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [revision, setRevision] = useState(initial.revision);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"saved" | "conflict" | "failed" | null>(
    null,
  );

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);

    try {
      const response = await fetch("/api/admin/autonomous-completion", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, expectedRevision: revision }),
      });

      if (!response.ok) {
        setStatus(response.status === 409 ? "conflict" : "failed");

        return;
      }
      const result = (await response.json()) as { revision: number };

      setRevision(result.revision);
      setStatus("saved");
    } catch {
      setStatus("failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-4 grid gap-3 rounded-lg border border-line bg-paper p-4 text-sm"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <h3 className="font-semibold">{t("platformTitle")}</h3>
      <label className="flex gap-2">
        <input
          checked={enabled}
          type="checkbox"
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t("enabled")}
      </label>
      <div className="flex items-center gap-2">
        <button
          className="rounded border border-line px-3 py-1.5"
          disabled={saving}
          type="submit"
        >
          {t("save")}
        </button>
        {status ? <p role="status">{t(`status.${status}`)}</p> : null}
      </div>
    </form>
  );
}
