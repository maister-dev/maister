"use client";

import type {
  PackageManifestFormLabels,
  PackageManifestModel,
} from "@/lib/local-packages/manifest";
import type { ReactElement, ReactNode } from "react";

import { useState } from "react";

import { CodeEditor } from "@/components/flows/code-editor";
import {
  applyManifestScalars,
  parsePackageManifest,
  validatePackageManifestYaml,
} from "@/lib/local-packages/manifest";

export type { PackageManifestFormLabels };

/**
 * Structured editor for `maister-package.yaml` (ADR-105, M39 Stream A). The form
 * edits the scalar fields (name + metadata.title/summary) and shows the entry
 * arrays read-only; a raw-YAML toggle exposes the full document. Form-mode edits
 * re-serialize the parsed manifest (comments are not preserved — use raw mode to
 * keep exact formatting). The content prop is the source of truth, so edits flow
 * out via `onChange` and back in as a re-parse (cursor is stable because the
 * round-trip echoes the typed value verbatim).
 */
export function PackageManifestForm({
  content,
  readOnly,
  labels,
  onChange,
}: {
  content: string;
  readOnly: boolean;
  labels: PackageManifestFormLabels;
  onChange: (next: string) => void;
}): ReactElement {
  const [mode, setMode] = useState<"form" | "raw">("form");
  const parsed = parsePackageManifest(content);
  const issues = validatePackageManifestYaml(content);
  const effectiveMode = parsed.ok ? mode : "raw";

  return (
    <div className="grid gap-3" data-testid="package-manifest-form">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {labels.heading}
        </span>
        {parsed.ok ? (
          <div className="flex rounded-md border border-line bg-paper p-0.5">
            <ModeButton
              active={effectiveMode === "form"}
              label={labels.formMode}
              testid="manifest-mode-form"
              onClick={() => setMode("form")}
            />
            <ModeButton
              active={effectiveMode === "raw"}
              label={labels.rawMode}
              testid="manifest-mode-raw"
              onClick={() => setMode("raw")}
            />
          </div>
        ) : null}
      </div>

      {parsed.ok ? null : (
        <p
          className="m-0 rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-amber"
          data-testid="manifest-parse-error"
          role="alert"
        >
          {labels.parseError} — {parsed.error}
        </p>
      )}

      {effectiveMode === "form" && parsed.ok ? (
        <ManifestFields
          labels={labels}
          model={parsed.model}
          raw={parsed.raw}
          readOnly={readOnly}
          onChange={onChange}
        />
      ) : (
        <CodeEditor
          ariaLabel="maister-package.yaml"
          kind="manifest"
          readOnly={readOnly}
          value={content}
          onChange={onChange}
        />
      )}

      {issues.length > 0 ? (
        <ul
          className="m-0 grid list-none gap-1 p-0"
          data-testid="manifest-issues"
        >
          {issues.map((issue) => (
            <li
              key={issue}
              className="rounded-md border border-danger-line bg-danger-soft px-2.5 py-1 font-mono text-[10.5px] text-danger"
            >
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ManifestFields({
  model,
  raw,
  readOnly,
  labels,
  onChange,
}: {
  model: PackageManifestModel;
  raw: Record<string, unknown>;
  readOnly: boolean;
  labels: PackageManifestFormLabels;
  onChange: (next: string) => void;
}): ReactElement {
  const emit = (edits: {
    name: string;
    title: string;
    summary: string;
  }): void => onChange(applyManifestScalars(raw, edits));

  return (
    <div className="grid gap-3">
      <Field label={labels.name}>
        <input
          className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-60"
          data-testid="manifest-field-name"
          disabled={readOnly}
          value={model.name}
          onChange={(event) =>
            emit({
              name: event.target.value,
              title: model.title,
              summary: model.summary,
            })
          }
        />
      </Field>
      <Field label={labels.displayTitle}>
        <input
          className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-60"
          data-testid="manifest-field-title"
          disabled={readOnly}
          value={model.title}
          onChange={(event) =>
            emit({
              name: model.name,
              title: event.target.value,
              summary: model.summary,
            })
          }
        />
      </Field>
      <Field label={labels.summary}>
        <textarea
          className="min-h-[64px] rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-60"
          data-testid="manifest-field-summary"
          disabled={readOnly}
          value={model.summary}
          onChange={(event) =>
            emit({
              name: model.name,
              title: model.title,
              summary: event.target.value,
            })
          }
        />
      </Field>

      <EntryList
        empty={labels.empty}
        entries={model.flows}
        label={labels.flows}
      />
      <EntryList
        empty={labels.empty}
        entries={model.capabilities}
        label={labels.capabilities}
      />
      <CountRow count={model.mcpCount} label={labels.mcps} />
      <CountRow count={model.restrictionCount} label={labels.restrictions} />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
        {label}
      </span>
      {children}
    </label>
  );
}

function EntryList({
  label,
  entries,
  empty,
}: {
  label: string;
  entries: { id: string; path: string }[];
  empty: string;
}): ReactElement {
  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
        {label} ({entries.length})
      </span>
      {entries.length === 0 ? (
        <span className="font-mono text-[11px] text-mute">{empty}</span>
      ) : (
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px]"
            >
              <span className="text-ink">{entry.id}</span>
              <span className="truncate text-mute">{entry.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CountRow({
  label,
  count,
}: {
  label: string;
  count: number;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
      <span className="font-semibold uppercase tracking-[0.08em] text-mute">
        {label}
      </span>
      <span className="text-ink-2">{count}</span>
    </div>
  );
}

function ModeButton({
  active,
  label,
  testid,
  onClick,
}: {
  active: boolean;
  label: string;
  testid: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      aria-pressed={active}
      className={`rounded-[6px] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] transition-colors ${
        active ? "bg-ivory text-ink" : "text-mute hover:text-ink"
      }`}
      data-testid={testid}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
