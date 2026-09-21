"use client";

// ADR-177 (D11/D25): the shared key/value rows control, EXTRACTED from the ACP
// runner modal rather than written beside it — which is why its markup is the
// runner modal's: the header-row add button with a plus glyph, per-row
// `aria-label`led key/value inputs, and a trash-glyph remove button. Those are
// the affordance conventions in `web/CLAUDE.md`, and keeping them means the
// runner modal's own assertions pass unchanged through the swap.
//
// Consumers: the runner modal (env), the platform MCP modal, the project MCP
// modal, the binding overlay dialog and the Studio MCP template editor — all
// editing the same `Record<name, value>` shape.
//
// Labels are PROPS, not `useTranslations` calls: each consumer owns its own
// i18n namespace (the `McpSelect` / `McpTemplateEditor` pattern).

import type { ReactElement } from "react";

import { useId } from "react";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

export type KeyValueRow = { id: string; key: string; value: string };

export type KeyValueRowsLabels = {
  title: string;
  hint?: string;
  key: string;
  value: string;
  add: string;
  remove: string;
};

export type KeyValueRowsProps = {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  labels: KeyValueRowsLabels;
  keySuggestions?: readonly string[];
  // Inline and NON-blocking: the secret guard is a warning, never a refusal.
  warningFor?: (row: KeyValueRow) => string | null;
  // Inline and blocking: the consumer disables submit while any row has one.
  errorFor?: (row: KeyValueRow) => string | null;
  // A group-level message below the rows (the runner modal's `errorFor("env")`).
  error?: string | null;
  disabled?: boolean;
  testId?: string;
};

const inputClass =
  "h-9 w-full rounded-[8px] border border-line bg-paper px-2.5 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-50";

const fieldLabel =
  "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

let rowSeq = 0;

function nextRowId(): string {
  rowSeq += 1;

  return `kv-${rowSeq}-${Date.now()}`;
}

export function rowsFromRecord(
  record: Readonly<Record<string, string>> | undefined | null,
): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value], index) => ({
    id: `${key}-${index}`,
    key,
    value,
  }));
}

// Fully empty rows are dropped; a key with an empty value is kept as an EMPTY
// LITERAL, which is a legitimate thing to send a server. Duplicate keys are
// last-wins here — the consumer blocks submit on the flagged rows instead, so
// the author sees which two collide rather than silently losing one.
export function recordFromRows(
  rows: readonly KeyValueRow[],
): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key.length > 0 || value.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Rows carrying the same key after trimming. Every one of them is flagged, so
// the author sees the collision rather than losing a value to last-wins.
export function duplicateKeyIds(rows: readonly KeyValueRow[]): Set<string> {
  const byKey = new Map<string, string[]>();

  for (const row of rows) {
    const key = row.key.trim();

    if (key === "") continue;
    byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
  }

  return new Set([...byKey.values()].filter((ids) => ids.length > 1).flat());
}

export function KeyValueRows({
  rows,
  onChange,
  labels,
  keySuggestions,
  warningFor,
  errorFor,
  error,
  disabled,
  testId,
}: KeyValueRowsProps): ReactElement {
  const listId = useId();
  const suggest = keySuggestions && keySuggestions.length > 0;

  const patch = (id: string, next: Partial<KeyValueRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className={fieldLabel}>{labels.title}</span>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink hover:border-mute disabled:opacity-50"
          disabled={disabled}
          type="button"
          onClick={() =>
            onChange([...rows, { id: nextRowId(), key: "", value: "" }])
          }
        >
          <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {labels.add}
        </button>
      </div>
      {labels.hint ? (
        <span className="font-mono text-[10.5px] leading-4 text-mute">
          {labels.hint}
        </span>
      ) : null}
      {suggest ? (
        <datalist id={listId}>
          {keySuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const rowError = errorFor?.(row) ?? null;
            const warning = rowError ? null : (warningFor?.(row) ?? null);

            return (
              <div key={row.id} className="flex flex-col gap-1">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_36px]">
                  <input
                    aria-invalid={rowError ? true : undefined}
                    aria-label={labels.key}
                    autoComplete="off"
                    className={inputClass}
                    disabled={disabled}
                    list={suggest ? listId : undefined}
                    spellCheck={false}
                    type="text"
                    value={row.key}
                    onChange={(e) => patch(row.id, { key: e.target.value })}
                  />
                  <input
                    aria-invalid={rowError ? true : undefined}
                    aria-label={labels.value}
                    autoComplete="off"
                    className={inputClass}
                    disabled={disabled}
                    spellCheck={false}
                    type="text"
                    value={row.value}
                    onChange={(e) => patch(row.id, { value: e.target.value })}
                  />
                  <button
                    aria-label={labels.remove}
                    className="grid h-9 w-9 place-items-center rounded-[8px] border border-line text-mute hover:border-mute hover:text-ink disabled:opacity-50"
                    disabled={disabled}
                    title={labels.remove}
                    type="button"
                    onClick={() =>
                      onChange(rows.filter((r) => r.id !== row.id))
                    }
                  >
                    <TrashIcon aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
                {rowError ? (
                  <span className="font-mono text-[10.5px] text-[#b5332b]">
                    {rowError}
                  </span>
                ) : null}
                {warning ? (
                  <span
                    className="font-mono text-[10.5px] text-amber"
                    role="note"
                  >
                    {warning}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <span className="font-mono text-[10.5px] text-[#b5332b]">{error}</span>
      ) : null}
    </div>
  );
}
