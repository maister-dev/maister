"use client";

import type { Key, ReactElement } from "react";

import { Button, ListBox, Select } from "@heroui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  projectSlug: string;
  brainEnabled: boolean;
  // Whether the platform embedding provider + distillation model are configured.
  // Enabling with this false returns CONFIG (the enable-gate) — surfaced inline.
  platformConfigured: boolean;
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

// Per-project Project Brain toggle (ADR-122). Enabling is gated: the platform
// embedding provider AND distillation model must be configured, else the PATCH
// returns CONFIG (422) and nothing is persisted — the message renders inline.
export function ProjectBrainSettingsControl({
  projectSlug,
  brainEnabled,
  platformConfigured,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const labelId = useId();
  const [enabled, setEnabled] = useState(brainEnabled);
  const [savedEnabled, setSavedEnabled] = useState(brainEnabled);
  const [pending, setPending] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = enabled !== savedEnabled;
  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

  const options: Array<{ id: string; label: string }> = [
    { id: "on", label: t("brainEnabledOn") },
    { id: "off", label: t("brainEnabledOff") },
  ];

  async function save(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings`,
        { brainEnabled: enabled },
      );
      setSavedEnabled(enabled);
      setShowSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]">
      <div className="mb-1 text-[13px] font-semibold tracking-[-0.005em] text-ink">
        {t("brainProjectTitle")}
      </div>
      <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] tracking-[0.02em] text-mute">
        {t("brainProjectHint")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] flex-col gap-1.5">
          <span className={labelClass}>{t("brainEnabledLabel")}</span>
          <span className="sr-only" id={labelId}>
            {t("brainEnabledLabel")}
          </span>
          <Select
            aria-labelledby={labelId}
            selectedKey={enabled ? "on" : "off"}
            variant="secondary"
            onSelectionChange={(key: Key | null) => {
              setShowSaved(false);
              setEnabled(key === null ? enabled : String(key) === "on");
            }}
          >
            <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
              <ListBox aria-label={t("brainEnabledLabel")}>
                {options.map((option) => (
                  <ListBox.Item
                    key={option.id}
                    id={option.id}
                    textValue={option.label}
                  >
                    {option.label}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </label>
        <Button
          className="border-line bg-ink text-[13px] font-semibold text-paper"
          isDisabled={pending || !changed}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void save()}
        >
          {pending ? t("saving") : t("save")}
        </Button>
        {showSaved && !changed ? (
          <span
            aria-label={t("brainProjectSaved")}
            className="flex items-center text-emerald-600"
            role="status"
            title={t("brainProjectSaved")}
          >
            <CheckIcon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      {!platformConfigured ? (
        <p className="m-0 mt-2 font-mono text-[10px] leading-[1.5] text-mute">
          {t("brainNotConfigured")}
        </p>
      ) : null}
      {error ? (
        <p
          className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
