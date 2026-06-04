"use client";

import type { ProjectRunner } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  projectSlug: string;
  runners: ProjectRunner[];
  defaultRunnerId: string | null;
  effectiveDefaultRunnerId: string | null;
  defaultRunnerSource: "project" | "platform" | null;
};

async function patchJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }
}

function readinessClass(status: ProjectRunner["readinessStatus"]): string {
  if (status === "Ready") return "text-emerald-700";
  if (status === "NotReady") return "text-red-700";

  return "text-mute";
}

export function ProjectRunnerSettingsControl({
  projectSlug,
  runners,
  defaultRunnerId,
  effectiveDefaultRunnerId,
  defaultRunnerSource,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const [selectedRunnerId, setSelectedRunnerId] = useState(
    defaultRunnerId ?? "inherit",
  );
  const [savedRunnerId, setSavedRunnerId] = useState(defaultRunnerId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedEffectiveRunnerId =
    selectedRunnerId === "inherit"
      ? effectiveDefaultRunnerId
      : selectedRunnerId;
  const selectedRunner = useMemo(
    () => runners.find((runner) => runner.id === selectedEffectiveRunnerId),
    [runners, selectedEffectiveRunnerId],
  );
  const savedSelectValue = savedRunnerId ?? "inherit";

  async function save(): Promise<void> {
    setPending(true);
    setError(null);
    const nextRunnerId =
      selectedRunnerId === "inherit" ? null : selectedRunnerId;

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings/runner`,
        { runnerId: nextRunnerId },
      );
      setSavedRunnerId(nextRunnerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("projectDefaultRunner")}
          </span>
          <select
            className="h-10 rounded-[8px] border border-line bg-canvas px-3 text-[13px] text-ink outline-none"
            value={selectedRunnerId}
            onChange={(event) => setSelectedRunnerId(event.target.value)}
          >
            <option value="inherit">{t("inheritPlatformDefault")}</option>
            {runners.map((runner) => (
              <option
                key={runner.id}
                disabled={!runner.enabled || runner.readinessStatus !== "Ready"}
                value={runner.id}
              >
                {runner.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="h-10 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
          disabled={pending || selectedRunnerId === savedSelectValue}
          type="button"
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
        <span>
          {t("effectiveRunner")}: {selectedRunner?.id ?? "-"}
        </span>
        <span>{defaultRunnerSource ?? "-"}</span>
        {selectedRunner ? (
          <span className={readinessClass(selectedRunner.readinessStatus)}>
            {selectedRunner.readinessStatus}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
