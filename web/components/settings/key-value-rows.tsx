"use client";

// ADR-177 (D11/D25): the shared key/value rows control. Extracted from the ACP
// runner modal it originated in, and reused by the platform MCP modal, the
// project MCP modal, the binding overlay dialog and the Studio MCP template
// editor — all five edit the same `Record<name, value>` shape under the same
// `literal | env:NAME` grammar.
//
// Labels are PROPS, not `useTranslations` calls: each consumer owns its own
// i18n namespace (the `McpSelect` / `McpTemplateEditor` pattern), and that is
// what lets the runner modal keep its existing strings byte-for-byte.

import { useId } from "react";

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
  disabled?: boolean;
  testId?: string;
};

const inputClass =
  "min-h-[32px] w-full rounded-lg border border-line bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-50";

const fieldLabel =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute";

let rowSeq = 0;

function nextRowId(): string {
  rowSeq += 1;

  return `kv-${rowSeq}`;
}

export function rowsFromRecord(
  record: Readonly<Record<string, string>> | undefined | null,
): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({
    id: nextRowId(),
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
  const out: Record<string, string> = {};

  for (const row of rows) {
    if (row.key.trim() === "" && row.value === "") continue;
    out[row.key.trim()] = row.value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function KeyValueRows({
  rows,
  onChange,
  labels,
  keySuggestions,
  warningFor,
  errorFor,
  disabled,
  testId,
}: KeyValueRowsProps) {
  const listId = useId();

  const patch = (id: string, next: Partial<KeyValueRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <span className={fieldLabel}>{labels.title}</span>
      {keySuggestions && keySuggestions.length > 0 ? (
        <datalist id={listId}>
          {keySuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
      {rows.map((row) => {
        const error = errorFor?.(row) ?? null;
        const warning = error ? null : (warningFor?.(row) ?? null);

        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <input
                aria-invalid={error ? true : undefined}
                aria-label={labels.key}
                className={inputClass}
                disabled={disabled}
                list={keySuggestions?.length ? listId : undefined}
                value={row.key}
                onChange={(e) => patch(row.id, { key: e.target.value })}
              />
              <input
                aria-invalid={error ? true : undefined}
                aria-label={labels.value}
                className={inputClass}
                disabled={disabled}
                value={row.value}
                onChange={(e) => patch(row.id, { value: e.target.value })}
              />
              <button
                aria-label={labels.remove}
                className="min-h-[32px] rounded-lg border border-line px-2 font-mono text-[11px] text-rose-400 hover:border-rose-400 disabled:opacity-50"
                disabled={disabled}
                type="button"
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
              >
                ✕
              </button>
            </div>
            {error ? (
              <span className="font-mono text-[10px] text-rose-400">
                {error}
              </span>
            ) : null}
            {warning ? (
              <span className="font-mono text-[10px] text-amber" role="note">
                {warning}
              </span>
            ) : null}
          </div>
        );
      })}
      <button
        className="self-start rounded-lg border border-line px-2 py-1 font-mono text-[11px] text-mute hover:border-amber hover:text-ink disabled:opacity-50"
        disabled={disabled}
        type="button"
        onClick={() =>
          onChange([...rows, { id: nextRowId(), key: "", value: "" }])
        }
      >
        {labels.add}
      </button>
      {labels.hint ? (
        <span className="font-mono text-[10px] text-mute">{labels.hint}</span>
      ) : null}
    </div>
  );
}
