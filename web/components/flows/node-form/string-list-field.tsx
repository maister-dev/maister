"use client";

import type { ReactElement } from "react";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

export type StringListFieldLabels = {
  add: string;
  remove: string;
  placeholder: string;
};

const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const FIELD_CLS =
  "min-w-0 flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";

// One text input per item with a per-row danger trash button; an add-button
// appends an empty row (the add-first affordance when the list is empty). Writes
// a `string[]`. `readOnly` renders the rows read-only and drops add/remove.
export function StringListField({
  testid,
  label,
  values,
  labels,
  readOnly = false,
  onChange,
}: {
  testid: string;
  label: string;
  values: string[];
  labels: StringListFieldLabels;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): ReactElement {
  const setAt = (index: number, value: string): void =>
    onChange(
      values.map((entry, position) => (position === index ? value : entry)),
    );

  const removeAt = (index: number): void =>
    onChange(values.filter((_, position) => position !== index));

  const add = (): void => onChange([...values, ""]);

  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      <div className="grid gap-1.5" data-testid={testid}>
        {values.map((value, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              aria-label={`${label} ${index + 1}`}
              className={FIELD_CLS}
              data-testid={`${testid}-${index}`}
              placeholder={labels.placeholder}
              readOnly={readOnly}
              spellCheck={false}
              type="text"
              value={value}
              onChange={(event) => setAt(index, event.target.value)}
            />
            {readOnly ? null : (
              <button
                aria-label={labels.remove}
                className="shrink-0 rounded-md border border-line px-1.5 py-1 text-mute hover:border-danger hover:text-danger"
                data-testid={`${testid}-remove-${index}`}
                type="button"
                onClick={() => removeAt(index)}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {readOnly ? null : (
          <button
            className="inline-flex w-fit items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-ink"
            data-testid={`${testid}-add`}
            type="button"
            onClick={add}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            {labels.add}
          </button>
        )}
      </div>
    </label>
  );
}
