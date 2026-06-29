"use client";

import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { CodeEditor } from "@/components/flows/code-editor";

export interface McpTemplateEditorLabels {
  prefillHeading: string;
  prefillHint: string;
  catalogLabel: string;
  catalogPlaceholder: string;
  catalogEmpty: string;
  apply: string;
  secretNotice: string;
  rawHeading: string;
  invalidNotice: string;
}

export interface McpTemplateEditorProps {
  content: string;
  fileName: string;
  catalog: PlatformMcpCatalogEntry[];
  readOnly?: boolean;
  labels: McpTemplateEditorLabels;
  onChange: (next: string) => void;
}

type McpTemplate = {
  id: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: string[];
  description?: string;
};

// `mcps/<id>.yaml` → the id segment (stem) as the template id default.
function stemOf(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;

  return base.replace(/\.(ya?ml|json)$/i, "") || "mcp";
}

// Materialize a catalog row into a package-manifest MCP template. SECRETS NEVER
// CROSS: only the env/header var NAMES become `env:NAME` references (T2.1). The
// platform catalog's `sse` transport is mapped to the package schema's `http`
// (the package DSL admits only `stdio | http`). Provenance is display-only —
// the source server id is NOT written into the template.
function materialize(
  entry: PlatformMcpCatalogEntry,
  fileName: string,
): McpTemplate {
  const envNames = [...entry.envKeys, ...entry.headerKeys].map((key) =>
    key.startsWith("env:") ? key : `env:${key}`,
  );

  if (entry.transport === "stdio") {
    return {
      id: stemOf(fileName),
      transport: "stdio",
      command: entry.command ?? "",
      ...(entry.args.length > 0 ? { args: entry.args } : {}),
      ...(envNames.length > 0 ? { env: envNames } : {}),
      description: entry.id,
    };
  }

  return {
    id: stemOf(fileName),
    transport: "http",
    url: entry.url ?? "",
    ...(envNames.length > 0 ? { env: envNames } : {}),
    description: entry.id,
  };
}

/**
 * Editor for an `mcps/*` template file. A picker over the admin-managed
 * `platform_mcp_servers` catalog materializes a transport-aware MCP template
 * (command/args/url + `env:NAME` references ONLY) into the file, plus a raw YAML
 * surface for further edits. No secret VALUE is ever read or written, and the
 * source server id is not persisted (display-only provenance, T2.1).
 *
 * Uniform `content`/`onChange` contract so the package files editor dispatches
 * here by the `mcps/` path prefix.
 */
export function McpTemplateEditor({
  content,
  fileName,
  catalog,
  readOnly = false,
  labels,
  onChange,
}: McpTemplateEditorProps): ReactElement {
  const [selected, setSelected] = useState("");
  // `CodeEditor` seeds its buffer once and ignores later `value` swaps on a
  // mounted instance (see code-editor.tsx) — applying a template REPLACES the
  // whole document, so we must remount the editor to re-seed it. Bumping this
  // key on apply does exactly that; ordinary typing flows through onChange and
  // needs no remount.
  const [rawSeed, setRawSeed] = useState(0);

  const parsedValid = useMemo(() => {
    if (content.trim() === "") return true;
    try {
      parseYaml(content);

      return true;
    } catch {
      return false;
    }
  }, [content]);

  const applyTemplate = (): void => {
    const entry = catalog.find((row) => row.id === selected);

    if (!entry) return;
    onChange(stringifyYaml(materialize(entry, fileName)));
    setRawSeed((seed) => seed + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-ivory/40 px-3.5 py-3">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.prefillHeading}
        </span>
        <p className="m-0 font-mono text-[10.5px] leading-snug text-mute">
          {labels.prefillHint}
        </p>

        {catalog.length === 0 ? (
          <p className="m-0 text-[12px] text-mute">{labels.catalogEmpty}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                {labels.catalogLabel}
              </span>
              <select
                className="min-h-[36px] rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-60"
                data-testid="mcp-template-catalog"
                disabled={readOnly}
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">{labels.catalogPlaceholder}</option>
                {catalog.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.id} · {row.transport}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="h-[36px] rounded-md border border-amber-line bg-amber-soft px-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber hover:bg-paper disabled:opacity-50"
              data-testid="mcp-template-apply"
              disabled={readOnly || selected === ""}
              type="button"
              onClick={applyTemplate}
            >
              {labels.apply}
            </button>
          </div>
        )}

        <p className="m-0 font-mono text-[10.5px] leading-snug text-mute">
          {labels.secretNotice}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.rawHeading}
        </span>
        {parsedValid ? null : (
          <p
            className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
            role="alert"
          >
            {labels.invalidNotice}
          </p>
        )}
        <CodeEditor
          key={rawSeed}
          ariaLabel={`${labels.rawHeading}: ${fileName}`}
          kind="asset"
          readOnly={readOnly}
          value={content}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
