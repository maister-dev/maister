"use client";

import type { ReactElement } from "react";

import { useState } from "react";

// ADR-129 (W-G, T7.1): the ONE MCP-select component shared by the flow node
// editor (`settings.mcps`, authoring refIds with free-add forward-refs) and the
// scratch launcher (record-id selection over a resolved catalog). Both models
// reduce to a `string[]` of selected values over `McpSelectOption[]`; the caller
// maps its native option shape into this contract and supplies i18n via props
// (mirrors `MultiSelectField`, which also takes labels as props). Grouped by
// source with optional trust/readiness badges — secrets never reach here, only
// NAMES + status. `allowFreeAdd` preserves the node forward-ref semantics; the
// scratch launcher passes a fixed catalog (no free-add).

export type McpSelectOption = {
  // The stable selection key: a refId (node) or a capability record id (scratch).
  value: string;
  label: string;
  // Grouping key + header; absent → the "custom" group (free-added forward-refs).
  source?: string;
  // Optional status badges (rendered only when the caller provides them).
  trust?: string;
  readiness?: string;
  // Optional secondary line (e.g. scratch's `enforceability`).
  detail?: string;
};

export type McpSelectLabels = {
  empty: string;
  // Free-add-only (node editor); the scratch launcher omits them.
  placeholder?: string;
  add?: string;
  // Per-source group header text; falls back to the raw source token.
  sourceLabels?: Partial<Record<string, string>>;
  // Localized badge text keyed by the raw trust / readiness token; falls back
  // to the raw token so an unmapped value still renders honestly.
  trustLabels?: Partial<Record<string, string>>;
  readinessLabels?: Partial<Record<string, string>>;
};

const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const GROUP_CLS =
  "font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-mute";
const FIELD_CLS =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const SELECTED_CHIP_CLS =
  "inline-flex items-center gap-1.5 rounded-full border border-amber bg-amber-soft px-2.5 py-1 font-mono text-[11px] text-ink";
const UNSELECTED_CHIP_CLS =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[11px] text-ink-2 hover:border-amber hover:text-ink";
const BADGE_CLS =
  "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]";

// Untrusted / not-ready are the states worth flagging in amber; everything else
// (trusted, ready) is the quiet default and gets a neutral badge.
function badgeTone(token: string): string {
  const t = token.toLowerCase();

  if (t === "trusted" || t === "trusted_by_policy" || t === "ready") {
    return "border-emerald-500/30 text-emerald-700";
  }
  if (t === "untrusted" || t === "not_ready" || t === "failed") {
    return "border-amber/50 text-amber-2";
  }

  return "border-line text-mute";
}

// `package` is the hub vocabulary; `flow-package` is the raw capability_records
// source (scratch options). Both rank third so a package group never sorts after
// the free-add "custom" group.
const SOURCE_ORDER = [
  "platform",
  "project",
  "package",
  "flow-package",
  "custom",
];

function sourceRank(source: string): number {
  const i = SOURCE_ORDER.indexOf(source);

  return i === -1 ? SOURCE_ORDER.length : i;
}

export function McpSelect({
  testid,
  label,
  values,
  options,
  labels,
  allowFreeAdd = false,
  readOnly = false,
  onChange,
}: {
  testid: string;
  // Optional: the scratch launcher wraps this in its own <details> summary, so
  // it passes no label; the node editor passes the field label.
  label?: string;
  values: string[];
  options: readonly McpSelectOption[];
  labels: McpSelectLabels;
  allowFreeAdd?: boolean;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const selected = new Set(values);
  const byValue = new Map(options.map((option) => [option.value, option]));

  // Selected values with no catalog entry are free-added forward-refs (node) —
  // surface them as a synthetic `custom` group so they stay visible + removable.
  const merged: McpSelectOption[] = [...options];

  for (const value of values) {
    if (!byValue.has(value)) {
      merged.push({ value, label: value, source: "custom" });
    }
  }

  // Type-to-filter parity with the old MultiSelectField: a non-empty free-add
  // query narrows the UNSELECTED options; selected chips always stay visible.
  const q = query.trim().toLowerCase();
  const visible = merged.filter(
    (option) =>
      selected.has(option.value) ||
      q === "" ||
      option.label.toLowerCase().includes(q) ||
      option.value.toLowerCase().includes(q),
  );
  // In read-only mode only the selected set is shown (package viewer / previews).
  const shown = readOnly
    ? visible.filter((o) => selected.has(o.value))
    : visible;

  const groups = new Map<string, McpSelectOption[]>();

  for (const option of shown) {
    const key = option.source ?? "custom";
    const list = groups.get(key) ?? [];

    list.push(option);
    groups.set(key, list);
  }

  const orderedGroups = [...groups.entries()].sort(
    (a, b) => sourceRank(a[0]) - sourceRank(b[0]) || a[0].localeCompare(b[0]),
  );

  const toggle = (value: string): void => {
    if (readOnly) return;
    onChange(
      selected.has(value)
        ? values.filter((entry) => entry !== value)
        : [...values, value],
    );
  };

  const trimmed = query.trim();
  const canFreeAdd =
    allowFreeAdd &&
    !readOnly &&
    trimmed.length > 0 &&
    !selected.has(trimmed) &&
    !byValue.has(trimmed);

  const freeAdd = (): void => {
    if (!canFreeAdd) return;
    onChange([...values, trimmed]);
    setQuery("");
  };

  return (
    <div className="grid gap-1.5">
      {label ? <span className={LABEL_CLS}>{label}</span> : null}
      <div className="grid gap-2" data-testid={testid}>
        {shown.length === 0 ? (
          <span className="font-mono text-[11px] text-mute">
            {labels.empty}
          </span>
        ) : null}
        {orderedGroups.map(([source, groupOptions]) => (
          <div key={source} className="grid gap-1">
            {groups.size > 1 || source !== "custom" ? (
              <span className={GROUP_CLS}>
                {labels.sourceLabels?.[source] ?? source}
              </span>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {groupOptions.map((option) => {
                const isSelected = selected.has(option.value);

                return (
                  <button
                    key={option.value}
                    aria-pressed={isSelected}
                    className={
                      isSelected ? SELECTED_CHIP_CLS : UNSELECTED_CHIP_CLS
                    }
                    data-testid={`${testid}-option-${option.value}`}
                    disabled={readOnly}
                    title={option.detail}
                    type="button"
                    onClick={() => toggle(option.value)}
                  >
                    <span>{option.label}</span>
                    {option.trust ? (
                      <span
                        className={`${BADGE_CLS} ${badgeTone(option.trust)}`}
                      >
                        {labels.trustLabels?.[option.trust] ?? option.trust}
                      </span>
                    ) : null}
                    {option.readiness ? (
                      <span
                        className={`${BADGE_CLS} ${badgeTone(option.readiness)}`}
                      >
                        {labels.readinessLabels?.[option.readiness] ??
                          option.readiness}
                      </span>
                    ) : null}
                    {isSelected && !readOnly ? (
                      <span aria-hidden="true" className="text-mute">
                        ×
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {allowFreeAdd && !readOnly ? (
          <div className="flex gap-1.5">
            <input
              aria-label={labels.placeholder}
              autoComplete="off"
              className={`${FIELD_CLS} flex-1`}
              data-testid={`${testid}-input`}
              placeholder={labels.placeholder}
              spellCheck={false}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canFreeAdd) {
                  event.preventDefault();
                  freeAdd();
                }
              }}
            />
            {canFreeAdd ? (
              <button
                className="rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink-2 hover:border-amber hover:text-ink"
                data-testid={`${testid}-free-add`}
                type="button"
                onClick={freeAdd}
              >
                {labels.add} “{trimmed}”
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
