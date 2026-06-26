"use client";

import type {
  ReferenceSourceGroup,
  ReferenceSourceKind,
} from "@/lib/flows/editor/reference-sources";
import type { ReactElement } from "react";

type UnknownSourceKind = Exclude<ReferenceSourceKind, "schema">;

export type ReferenceComboboxProps = {
  value: string;
  groups: readonly ReferenceSourceGroup[];
  label: string;
  placeholder: string;
  emptyHint: string;
  readOnly: boolean;
  testid: string;
  unknownKind?: UnknownSourceKind;
  asRunnerLabel?: string;
  asAgentLabel?: string;
  onInputValue: (value: string) => void;
  onSelect: (value: string, kind: ReferenceSourceKind) => void;
  onUnknownKindChange: (kind: UnknownSourceKind) => void;
};

const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-70";
const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const GROUP_CLS =
  "font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-mute";
const OPTION_CLS =
  "rounded-md border border-line bg-muted/30 px-2 py-1 text-left font-mono text-[12px] text-ink hover:border-amber";
const TOGGLE_CLS =
  "rounded-md border border-line px-2 py-1 font-mono text-[11px] text-mute data-[active=true]:border-amber data-[active=true]:text-ink";

export function ReferenceCombobox({
  value,
  groups,
  label,
  placeholder,
  emptyHint,
  readOnly,
  testid,
  unknownKind,
  asRunnerLabel,
  asAgentLabel,
  onInputValue,
  onSelect,
  onUnknownKindChange,
}: ReferenceComboboxProps): ReactElement {
  const optionCount = groups.reduce(
    (count, group) => count + group.options.length,
    0,
  );
  const showUnknownToggle =
    !readOnly &&
    value.trim().length > 0 &&
    unknownKind !== undefined &&
    asRunnerLabel !== undefined &&
    asAgentLabel !== undefined;

  return (
    <div className="grid gap-2" data-testid={`${testid}-combobox`}>
      <label className="grid gap-1">
        <span className={LABEL_CLS}>{label}</span>
        <input
          className={FIELD_CLS}
          data-testid={testid}
          disabled={readOnly}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onInputValue(event.target.value)}
        />
      </label>

      {!readOnly ? (
        <div className="grid gap-2" data-testid={`${testid}-options`}>
          {optionCount === 0 ? (
            <p className="font-mono text-[11px] text-mute">{emptyHint}</p>
          ) : (
            groups.map((group) => (
              <div key={`${group.kind}:${group.label}`} className="grid gap-1">
                <div className={GROUP_CLS}>{group.label}</div>
                <div className="grid gap-1">
                  {group.options.map((option) => (
                    <button
                      key={`${option.kind}:${option.value}`}
                      className={OPTION_CLS}
                      data-kind={option.kind}
                      data-testid={`${testid}-option`}
                      data-value={option.value}
                      type="button"
                      onClick={() => onSelect(option.value, option.kind)}
                    >
                      <span>{option.label}</span>
                      {option.hint ? (
                        <span className="block text-[10px] text-mute">
                          {option.hint}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showUnknownToggle ? (
        <div className="flex flex-wrap gap-1" data-testid={`${testid}-unknown`}>
          <button
            className={TOGGLE_CLS}
            data-active={unknownKind === "runner"}
            type="button"
            onClick={() => onUnknownKindChange("runner")}
          >
            {asRunnerLabel}
          </button>
          <button
            className={TOGGLE_CLS}
            data-active={unknownKind === "agent"}
            type="button"
            onClick={() => onUnknownKindChange("agent")}
          >
            {asAgentLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
