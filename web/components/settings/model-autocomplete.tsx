"use client";

import type { ReactElement } from "react";

import { useTranslations } from "next-intl";
import { Chip, Spinner } from "@heroui/react";

export type ModelGroup = {
  source: string;
  label: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  models: { id: string; displayName?: string }[];
};

export type ModelAutocompleteProps = {
  value: string;
  onValueChange: (v: string) => void;
  groups: ModelGroup[];
  loading: boolean;
  error: boolean;
  unknownModel: boolean;
  onRefresh: () => void;
  label: string;
};

// Localized origin-badge labels (EN/RU catalogs both ship them); the server's
// EN `label` stays the fallback for sources this build does not know yet.
const SOURCE_LABEL_KEYS: Record<string, string> = {
  acp_probe: "agent",
  provider_api: "provider",
  curated: "curated",
  ccr: "ccr",
  agent_observed: "observed",
  preset: "preset",
};

const inputClass =
  "min-h-[36px] w-full rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

// Model field = a free-text input (any model id is always valid — unknown is an
// advisory hint, never a validation error) PLUS discovery-backed suggestions
// rendered as grouped, origin-badged chips that fill the input on click. A
// native <input> (matching the modal's other fields) is used deliberately
// instead of a dropdown combobox: the suggestion set is small and always
// visible, and a Popover-in-Modal combobox is brittle.
export function ModelAutocomplete({
  value,
  onValueChange,
  groups,
  loading,
  error,
  unknownModel,
  onRefresh,
  label,
}: ModelAutocompleteProps): ReactElement {
  const t = useTranslations("settings");
  const visibleGroups = groups.filter((group) => group.models.length > 0);
  const badgeLabel = (group: ModelGroup): string => {
    const key = SOURCE_LABEL_KEYS[group.source];

    return key ? t(`modelSuggestions.sources.${key}`) : group.label;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={fieldLabel}>{label}</span>
        <button
          aria-label={t("modelSuggestions.refresh")}
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
          disabled={loading}
          type="button"
          onClick={onRefresh}
        >
          {t("modelSuggestions.refresh")}
        </button>
      </div>

      <input
        aria-label={label}
        autoComplete="off"
        className={inputClass}
        spellCheck={false}
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      />

      {unknownModel ? (
        <span className="font-mono text-[10.5px] text-mute">
          {t("modelSuggestions.unknownModelHint")}
        </span>
      ) : null}

      {error ? (
        <span className="font-mono text-[10.5px] text-[#b5332b]">
          {t("modelSuggestions.error")}
        </span>
      ) : null}

      <div className="flex flex-col gap-1.5" data-slot="model-suggestions">
        {loading ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-mute">
            <Spinner className="h-3 w-3" />
            {t("modelSuggestions.loading")}
          </span>
        ) : visibleGroups.length === 0 ? (
          <span className="font-mono text-[10.5px] text-mute">
            {t("modelSuggestions.empty")}
          </span>
        ) : (
          visibleGroups.map((group) => (
            <div key={group.source} className="flex flex-col gap-1">
              <Chip
                className="self-start font-mono text-[9px] uppercase tracking-[0.08em]"
                size="sm"
                variant="secondary"
              >
                {badgeLabel(group)}
              </Chip>
              <div className="flex flex-wrap gap-1.5">
                {group.models.map((model) => (
                  <button
                    key={`${group.source}:${model.id}`}
                    className="rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-ink"
                    title={model.displayName ?? model.id}
                    type="button"
                    onClick={() => onValueChange(model.id)}
                  >
                    {model.displayName
                      ? `${model.id} · ${model.displayName}`
                      : model.id}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
