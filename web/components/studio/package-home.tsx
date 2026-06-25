"use client";

import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement } from "react";

import Link from "next/link";

import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { PACKAGE_MANIFEST_FILENAME } from "@/lib/local-packages/manifest";

export type PackageHomeLabels = {
  orientation: string;
  flowsHeading: string;
  noFlows: string;
  save: string;
};

type ServerFormAction = (formData: FormData) => void | Promise<void>;

// A working-dir path the canvas can compile (a flow manifest); mirrors the page's
// `isFlowPath`. Flow files link to the canvas editor; everything else is edited
// inline below (the manifest, skills, agents, rules, …).
function isFlowPath(path: string): boolean {
  return (
    path === "flow.yaml" ||
    (path.startsWith("flows/") && /\.ya?ml$/i.test(path))
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The /studio/edit landing when no flow file is selected (ADR-105, M39 Stream A).
 * Replaces the empty flow canvas (which fired a spurious "YAML is invalid" banner)
 * with a package overview: the manifest form + file tree (via PackageFilesEditor,
 * landing on `maister-package.yaml`) and quick links to open each flow on the
 * canvas. Saving reuses the working-dir `saveAction` (no flow buffer, so the
 * submit carries only the file changes).
 */
export function PackageHome({
  packageId,
  name,
  files,
  readOnly,
  labels,
  filesLabels,
  fileKindLabels,
  mcpCatalog,
  saveAction,
  onDirtyChange,
}: {
  packageId: string;
  name: string;
  files: AuthoredFlowPackageFile[];
  readOnly: boolean;
  labels: PackageHomeLabels;
  filesLabels: PackageFilesEditorLabels;
  fileKindLabels: Record<AuthoredFlowPackageFileKind, string>;
  mcpCatalog: PlatformMcpCatalogEntry[];
  saveAction: ServerFormAction;
  onDirtyChange?: (dirty: boolean) => void;
}): ReactElement {
  const flows = files.filter((file) => isFlowPath(file.path));

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-auto rounded-xl border border-line bg-paper p-4"
      data-testid="package-home"
    >
      <header className="grid gap-1">
        <h2 className="m-0 font-mono text-[14px] font-bold text-ink">{name}</h2>
        <p className="m-0 font-mono text-[11px] text-mute">
          {labels.orientation}
        </p>
      </header>

      <section className="grid gap-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {labels.flowsHeading} ({flows.length})
        </span>
        {flows.length === 0 ? (
          <span className="font-mono text-[11px] text-mute">
            {labels.noFlows}
          </span>
        ) : (
          <ul className="m-0 flex flex-wrap gap-2 p-0">
            {flows.map((flow) => (
              <li key={flow.path}>
                <Link
                  className="block rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[11px] text-ink hover:border-amber"
                  data-testid="package-home-flow-link"
                  href={`/studio/edit/${packageId}/${encodePath(flow.path)}`}
                >
                  {flow.path}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={saveAction} className="grid min-h-0 flex-1 gap-3">
        <PackageFilesEditor
          disabled={readOnly}
          files={files}
          initialSelectedPath={PACKAGE_MANIFEST_FILENAME}
          kindLabels={fileKindLabels}
          labels={filesLabels}
          mcpCatalog={mcpCatalog}
          onDirtyChange={onDirtyChange}
        />
        {readOnly ? null : (
          <button
            className="justify-self-start rounded-md border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
            data-testid="package-home-save"
            type="submit"
          >
            {labels.save}
          </button>
        )}
      </form>
    </div>
  );
}
