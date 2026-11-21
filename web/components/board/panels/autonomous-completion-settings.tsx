"use client";

import type { CompletionSettings } from "@/lib/auto-promotion/completion-policy";
import type { z } from "zod";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import {
  completionRisk,
  DEFAULT_COMPLETION_LIMITS,
  projectCompletionPatchSchema,
} from "@/lib/auto-promotion/completion-policy";

type Risk = z.infer<typeof completionRisk>;

export function AutonomousCompletionSettings({
  slug,
  revision,
  settings,
}: {
  slug: string;
  revision: number;
  settings: CompletionSettings | null;
}) {
  const t = useTranslations("completionSettings");
  const [currentRevision, setRevision] = useState(revision);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [risk, setRisk] = useState<Risk>(
    settings?.riskMax ?? DEFAULT_COMPLETION_LIMITS.riskMax,
  );
  const [confidence, setConfidence] = useState(
    String(settings?.confidenceMin ?? DEFAULT_COMPLETION_LIMITS.confidenceMin),
  );
  const [files, setFiles] = useState(
    String(
      settings?.changedFilesMax ?? DEFAULT_COMPLETION_LIMITS.changedFilesMax,
    ),
  );
  const [lines, setLines] = useState(
    String(
      settings?.changedLinesMax ?? DEFAULT_COMPLETION_LIMITS.changedLinesMax,
    ),
  );
  const [sources, setSources] = useState(
    settings?.approvedCiSources?.join("\n") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    "saved" | "invalid" | "conflict" | "failed" | null
  >(null);
  const field = "rounded border border-line bg-paper px-2 py-1";

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const approvedCiSources = sources
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const patch = projectCompletionPatchSchema.safeParse({
      enabled,
      expectedRevision: currentRevision,
      riskMax: risk,
      confidenceMin: Number(confidence),
      changedFilesMax: Number(files),
      changedLinesMax: Number(lines),
      ...(approvedCiSources.length ? { approvedCiSources } : {}),
    });

    if (!patch.success || (enabled && approvedCiSources.length === 0)) {
      setStatus("invalid");

      return;
    }
    setSaving(true);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/settings`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autonomousCompletion: patch.data }),
        },
      );

      if (!response.ok) {
        setStatus(response.status === 409 ? "conflict" : "failed");

        return;
      }
      const result = (await response.json()) as {
        autonomousCompletion: { revision: number };
      };

      setRevision(result.autonomousCompletion.revision);
      setStatus("saved");
    } catch {
      setStatus("failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-lg border border-line bg-paper p-4 text-sm"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <h3 className="font-semibold">{t("projectTitle")}</h3>
      <label className="flex gap-2">
        <input
          checked={enabled}
          type="checkbox"
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t("enabled")}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          {t("riskMax")}
          <select
            className={field}
            value={risk}
            onChange={(e) => setRisk(completionRisk.parse(e.target.value))}
          >
            {completionRisk.options.map((value) => (
              <option key={value} value={value}>
                {t(`risk.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          {t("confidenceMin")}
          <input
            required
            className={field}
            max="1"
            min="0"
            step="0.01"
            type="number"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          {t("changedFilesMax")}
          <input
            required
            className={field}
            min="1"
            type="number"
            value={files}
            onChange={(e) => setFiles(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          {t("changedLinesMax")}
          <input
            required
            className={field}
            min="1"
            type="number"
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
        </label>
      </div>
      <label className="grid gap-1">
        {t("sources")}
        <textarea
          className={field}
          rows={3}
          value={sources}
          onChange={(e) => setSources(e.target.value)}
        />
        <span className="text-xs text-mute">{t("sourceHelp")}</span>
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
