"use client";

import type { ReactElement } from "react";

import { useTranslations } from "next-intl";
import {
  Chip,
  ComboBox,
  Header,
  Input,
  Label,
  ListBox,
  Spinner,
} from "@heroui/react";

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

const inputClass =
  "min-h-[36px] w-full rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

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
  const hasModels = groups.some((group) => group.models.length > 0);

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

      <ComboBox
        allowsCustomValue
        aria-label={label}
        inputValue={value}
        menuTrigger="focus"
        onInputChange={onValueChange}
      >
        <Label className="sr-only">{label}</Label>
        <ComboBox.InputGroup className={inputClass}>
          <Input
            autoComplete="off"
            className="w-full bg-transparent outline-none"
            spellCheck={false}
          />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <ListBox>
            {groups
              .filter((group) => group.models.length > 0)
              .map((group) => (
                <ListBox.Section key={group.source}>
                  <Header>{group.label}</Header>
                  {group.models.map((model) => (
                    <ListBox.Item
                      key={`${group.source}:${model.id}`}
                      id={model.id}
                      textValue={model.id}
                    >
                      {model.displayName
                        ? `${model.id} · ${model.displayName}`
                        : model.id}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>

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
        ) : !hasModels ? (
          <span className="font-mono text-[10.5px] text-mute">
            {t("modelSuggestions.empty")}
          </span>
        ) : (
          groups
            .filter((group) => group.models.length > 0)
            .map((group) => (
              <div key={group.source} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <Chip
                    className="font-mono text-[9px] uppercase tracking-[0.08em]"
                    size="sm"
                    variant="secondary"
                  >
                    {group.label}
                  </Chip>
                </div>
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
