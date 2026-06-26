"use client";

import type { ReactElement } from "react";

import { useState } from "react";

export type MultiSelectOption = { value: string; label: string };

export type MultiSelectFieldLabels = {
  add: string;
  remove: string;
  placeholder: string;
  empty: string;
};

const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const CHIP_CLS =
  "inline-flex items-center gap-1 rounded-full border border-line bg-ivory px-2 py-0.5 font-mono text-[11px] text-ink";
const SUGGEST_CLS =
  "rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-ink";

// Selected values as removable chips + an add-combobox over `options`. Two modes:
// `catalog` allows free-add (a typed value not in `options` — forward-refs to a
// not-yet-authored skill/mcp); `fixed` rejects anything outside `options` (enum).
// Follows the model-autocomplete native-input + suggestion-list precedent rather
// than a Popover, which is brittle inside the editor's scroll container.
export function MultiSelectField({
  testid,
  label,
  values,
  options,
  mode,
  labels,
  readOnly = false,
  onChange,
}: {
  testid: string;
  label: string;
  values: string[];
  options: readonly MultiSelectOption[];
  mode: "catalog" | "fixed";
  labels: MultiSelectFieldLabels;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  // Suggestions stay hidden until the field is engaged (focused or being typed
  // into) so the form is not a wall of always-open option lists.
  const [focused, setFocused] = useState(false);
  const selected = new Set(values);
  const trimmed = query.trim();
  const available = options.filter(
    (option) =>
      !selected.has(option.value) &&
      (option.label.toLowerCase().includes(query.toLowerCase()) ||
        option.value.toLowerCase().includes(query.toLowerCase())),
  );
  const canFreeAdd =
    mode === "catalog" &&
    trimmed.length > 0 &&
    !selected.has(trimmed) &&
    !options.some((option) => option.value === trimmed);

  const labelFor = (value: string): string =>
    options.find((option) => option.value === value)?.label ?? value;

  const add = (value: string): void => {
    const next = value.trim();

    if (next.length === 0 || selected.has(next)) return;
    onChange([...values, next]);
    setQuery("");
  };

  const remove = (value: string): void =>
    onChange(values.filter((entry) => entry !== value));

  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <div className="grid gap-1.5" data-testid={testid}>
        {values.length === 0 && readOnly ? (
          <span className="font-mono text-[11px] text-mute">
            {labels.empty}
          </span>
        ) : null}
        {values.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {values.map((value) => (
              <span
                key={value}
                className={CHIP_CLS}
                data-testid={`${testid}-chip`}
              >
                <span>{labelFor(value)}</span>
                {readOnly ? null : (
                  <button
                    aria-label={labels.remove}
                    className="text-mute hover:text-danger"
                    type="button"
                    onClick={() => remove(value)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        ) : null}
        {readOnly ? null : (
          <>
            <input
              aria-label={labels.placeholder}
              autoComplete="off"
              className={FIELD_CLS}
              data-testid={`${testid}-input`}
              placeholder={labels.placeholder}
              spellCheck={false}
              type="text"
              value={query}
              onBlur={() => setFocused(false)}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setFocused(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canFreeAdd) {
                  event.preventDefault();
                  add(trimmed);
                }
              }}
            />
            {(focused || trimmed.length > 0) &&
            (available.length > 0 || canFreeAdd) ? (
              <div className="flex flex-wrap gap-1.5">
                {available.map((option) => (
                  <button
                    key={option.value}
                    className={SUGGEST_CLS}
                    data-testid={`${testid}-option`}
                    type="button"
                    onClick={() => add(option.value)}
                    // preventDefault on mousedown keeps the input focused through
                    // the click so the list does not blur-close before it fires.
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    {option.label}
                  </button>
                ))}
                {canFreeAdd ? (
                  <button
                    className={SUGGEST_CLS}
                    data-testid={`${testid}-free-add`}
                    type="button"
                    onClick={() => add(trimmed)}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    {labels.add} “{trimmed}”
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </label>
  );
}
