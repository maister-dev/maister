"use client";

import type { TaskQueueSettings } from "@/lib/tasks/queue-settings";
import type { Key, ReactElement } from "react";

import { Button, Input, ListBox, Select } from "@heroui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  projectSlug: string;
  taskQueueSettings: TaskQueueSettings | null;
  // The env-resolved default (resolveEdgeDrain with no project override), shown on
  // the "Inherit" option so an admin sees what inheriting actually yields — the env
  // default can be OFF (Codex-3).
  envEdgeDrainDefault: boolean;
};

type EdgeDrainChoice = "inherit" | "on" | "off";

function initialEdgeDrainChoice(
  settings: TaskQueueSettings | null,
): EdgeDrainChoice {
  if (settings?.edgeDrain === undefined) return "inherit";

  return settings.edgeDrain ? "on" : "off";
}

// Canonical comparison key for the dirty-state gate: two settings that resolve to
// the same effective override compare equal regardless of object identity / key order.
function settingsKey(settings: TaskQueueSettings | null): string {
  if (!settings || Object.keys(settings).length === 0) return "null";

  return `e:${settings.edgeDrain ?? "-"}|m:${settings.maxInFlightAuto ?? "-"}`;
}

// Build the override from ONLY explicitly-set inputs. An absent key inherits the
// env default (resolveEdgeDrain: `override?.edgeDrain ?? env`), so "Inherit" omits
// edgeDrain — never write `{edgeDrain:true}` on an env-off deployment (Codex-3).
// Returns "invalid" when maxInFlightAuto is present but not a positive integer.
function buildSettings(
  edgeDrain: EdgeDrainChoice,
  maxInFlightAuto: string,
): TaskQueueSettings | null | "invalid" {
  const settings: TaskQueueSettings = {};

  if (edgeDrain !== "inherit") settings.edgeDrain = edgeDrain === "on";

  const trimmed = maxInFlightAuto.trim();

  if (trimmed !== "") {
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || parsed < 1) return "invalid";

    settings.maxInFlightAuto = parsed;
  }

  return Object.keys(settings).length === 0 ? null : settings;
}

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

function selectedValue<T extends string>(key: Key | null, fallback: T): T {
  if (key === null) return fallback;

  return String(key) as T;
}

export function QueueSettingsControl({
  projectSlug,
  taskQueueSettings,
  envEdgeDrainDefault,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const labelId = useId();
  const [edgeDrain, setEdgeDrain] = useState<EdgeDrainChoice>(
    initialEdgeDrainChoice(taskQueueSettings),
  );
  const [maxInFlightAuto, setMaxInFlightAuto] = useState(
    taskQueueSettings?.maxInFlightAuto != null
      ? String(taskQueueSettings.maxInFlightAuto)
      : "",
  );
  const [savedKey, setSavedKey] = useState(settingsKey(taskQueueSettings));
  const [pending, setPending] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = buildSettings(edgeDrain, maxInFlightAuto);
  const currentKey = current === "invalid" ? "invalid" : settingsKey(current);
  const changed = currentKey !== savedKey;

  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

  const edgeDrainOptions: Array<{ id: EdgeDrainChoice; label: string }> = [
    {
      id: "inherit",
      label: t("queueEdgeDrainInherit", {
        value: envEdgeDrainDefault
          ? t("queueEdgeDrainOn")
          : t("queueEdgeDrainOff"),
      }),
    },
    { id: "on", label: t("queueEdgeDrainOn") },
    { id: "off", label: t("queueEdgeDrainOff") },
  ];

  function onEdit(next: () => void): void {
    setShowSaved(false);
    next();
  }

  async function save(): Promise<void> {
    if (current === "invalid") {
      setError(t("queueMaxInFlightInvalid"));

      return;
    }

    setPending(true);
    setError(null);

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings`,
        { taskQueueSettings: current },
      );
      setSavedKey(settingsKey(current));
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
        {t("queueSettingsTitle")}
      </div>
      <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] tracking-[0.02em] text-mute">
        {t("queueSettingsHint")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] flex-col gap-1.5">
          <span className={labelClass}>{t("queueEdgeDrain")}</span>
          <span className="sr-only" id={labelId}>
            {t("queueEdgeDrain")}
          </span>
          <Select
            aria-labelledby={labelId}
            selectedKey={edgeDrain}
            variant="secondary"
            onSelectionChange={(key) =>
              onEdit(() =>
                setEdgeDrain(selectedValue<EdgeDrainChoice>(key, edgeDrain)),
              )
            }
          >
            <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
              <ListBox aria-label={t("queueEdgeDrain")}>
                {edgeDrainOptions.map((option) => (
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
        <label className="flex min-w-[200px] flex-col gap-1.5">
          <span className={labelClass}>{t("queueMaxInFlightAuto")}</span>
          <Input
            aria-label={t("queueMaxInFlightAuto")}
            className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink"
            inputMode="numeric"
            min={1}
            placeholder={t("queueMaxInFlightUnbounded")}
            type="number"
            value={maxInFlightAuto}
            onChange={(event) =>
              onEdit(() => setMaxInFlightAuto(event.target.value))
            }
          />
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
            aria-label={t("queueSaved")}
            className="flex items-center text-emerald-600"
            role="status"
            title={t("queueSaved")}
          >
            <CheckIcon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      <p className="m-0 mt-2 font-mono text-[10px] leading-[1.5] text-mute">
        {t("queueEdgeDrainHelp")} · {t("queueMaxInFlightAutoHelp")}
      </p>
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
