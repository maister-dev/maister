"use client";

import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type {
  EditorDrawerKind,
  EditorTopBarLabels,
} from "@/components/flows/editor/editor-top-bar";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { ReferenceSourceGroup } from "@/lib/flows/editor/reference-sources";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/flows/graph/topology";
import type { ReactElement, ReactNode } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { stringify as stringifyYaml } from "yaml";

import { CodeEditor } from "@/components/flows/code-editor";
import { EditorTopBar } from "@/components/flows/editor/editor-top-bar";
import { FlowDraftDiffText } from "@/components/flows/flow-draft-diff";
import { syncYamlToCanvas } from "@/lib/flows/editor/yaml-sync";
import { validateEditorManifest } from "@/lib/flows/editor/validation";

const YAML_SYNC_DEBOUNCE_MS = 400;

// ReactFlow does not SSR cleanly — mount the canvas client-only, mirroring the
// read-only M22 FlowGraphView (dynamic ssr:false).
const FlowGraphEditor = dynamic(
  () => import("@/components/flows/flow-graph-editor"),
  { ssr: false },
);

export type FlowEditorTabsLabels = {
  diffEmpty: string;
  syncError: string;
  topBar: EditorTopBarLabels;
  editor: FlowGraphEditorLabels;
};

type ServerFormAction = (formData: FormData) => void | Promise<void>;

/**
 * Phase B (T1.4–T1.6): the editor shell. A 3-pane layout — compact top bar +
 * dominant always-on canvas + overlay drawers (YAML / Diff / Files) — over the
 * UNCHANGED draft/publish backend. It is the SINGLE owner of the manifest state:
 * a single `flowYaml` value drives the canvas seed and is carried by the hidden
 * `name="flowYaml"` input so the existing save server action is reused verbatim.
 *
 * Load/save seam (spec §3.3): save/publish stay SERVER ACTIONS with the
 * `expectedDraftVersion` CAS + progressive enhancement, injected as
 * `saveAction`/`publishAction` (default = the authored-flow actions) so Phase C
 * can target a local package without rebuilding this shell.
 *
 * Live YAML↔canvas sync (preserved): a debounced effect parses the `yaml` buffer;
 * a valid, structurally-different manifest re-seeds the canvas (`seedKey`
 * remount), a parse/validate error keeps the last-good graph + an inline banner,
 * and a manifest equal to what the canvas last serialized is a no-op. Leaving the
 * YAML drawer flushes the pending sync FIRST so the canvas reflects the latest
 * edits without a mid-interaction remount.
 */
export function FlowEditorTabs({
  projectSlug,
  capId,
  draftVersion,
  identity,
  lifecycleLabel,
  initialTitle,
  canManage,
  hasDraft,
  readinessReady,
  initialYaml,
  initialManifest,
  topology,
  layout,
  diff,
  labels,
  canvasAvailable,
  participantSources,
  schemaFiles,
  saveAction,
  publishAction,
  filesDrawer,
  diffDrawer,
  onWriteSchemaFile,
  inspectorContainer,
  onDirtyChange,
}: {
  projectSlug: string;
  capId: string;
  draftVersion: number;
  identity: { project: string; slug: string; kind: string };
  lifecycleLabel: string;
  initialTitle: string;
  canManage: boolean;
  hasDraft: boolean;
  readinessReady: boolean;
  initialYaml: string;
  initialManifest: FlowYamlV1 | null;
  topology: GraphTopology | null;
  layout: FlowLayout | null;
  diff: string;
  labels: FlowEditorTabsLabels;
  canvasAvailable: boolean;
  participantSources?: ReferenceSourceGroup[];
  schemaFiles?: { path: string; content: string }[];
  saveAction: ServerFormAction;
  publishAction: ServerFormAction;
  filesDrawer: ReactNode;
  // Phase C/M36: when provided, the [Diff] drawer renders this git-backed diff
  // (working-tree-vs-HEAD of a local package) instead of the draft-vs-published
  // YAML text. Absent → the authored-flow path keeps `FlowDraftDiffText`.
  diffDrawer?: ReactNode;
  onWriteSchemaFile?: (path: string, content: string) => void;
  // Host container for the hoisted properties inspector (portal target). Threaded
  // to FlowGraphEditor; absent → inspector renders inline beside the canvas.
  inspectorContainer?: HTMLElement | null;
  onDirtyChange?: (dirty: boolean) => void;
}): ReactElement {
  const [yaml, setYaml] = useState(initialYaml);
  const [title, setTitle] = useState(initialTitle);
  // No canvas to fall back on (manifest does not compile) → open the YAML drawer
  // up front so the draft is still editable on load.
  const [openDrawer, setOpenDrawer] = useState<EditorDrawerKind | null>(
    canvasAvailable ? null : "yaml",
  );
  const [liveManifest, setLiveManifest] = useState<FlowYamlV1 | null>(
    initialManifest,
  );

  // The live seed for FlowGraphEditor. Starts at the server-compiled
  // manifest/topology/layout; a yaml-driven reseed swaps all three. `seedKey`
  // remounts the editor on reseed so it re-derives canvas state from the new
  // seed (selection resets only when the graph structurally changed).
  const [seed, setSeed] = useState<{
    manifest: FlowYamlV1;
    topology: GraphTopology;
    layout: FlowLayout;
  } | null>(
    initialManifest && topology && layout
      ? { manifest: initialManifest, topology, layout }
      : null,
  );
  const [seedKey, setSeedKey] = useState(0);
  const [syncError, setSyncError] = useState(false);

  useEffect(() => {
    onDirtyChange?.(yaml !== initialYaml || title !== initialTitle);
  }, [initialTitle, initialYaml, onDirtyChange, title, yaml]);

  // The manifest the canvas currently reflects: its last-serialized or
  // last-seeded state. The debounced reducer diffs the parsed yaml against this
  // to decide reseed-vs-noop. A canvas onChange updates it BEFORE setYaml so the
  // debounce that follows sees equality and does not bounce the canvas.
  const canvasManifestRef = useRef<FlowYamlV1 | null>(initialManifest);

  const runYamlSync = useCallback(() => {
    const decision = syncYamlToCanvas(yaml, canvasManifestRef.current);

    if (decision.kind === "noop") {
      setSyncError(false);

      return;
    }

    if (decision.kind === "error") {
      // eslint-disable-next-line no-console
      console.warn("[flowEditor] yaml parse error");
      setSyncError(true);

      return;
    }

    canvasManifestRef.current = decision.manifest;
    setSeed({
      manifest: decision.manifest,
      topology: decision.topology,
      layout: decision.layout,
    });
    setSeedKey((k) => k + 1);
    setLiveManifest(decision.manifest);
    setSyncError(false);
  }, [yaml]);

  // Sync yaml → canvas ONLY while the YAML drawer is open: there the user edits
  // the manifest text and the canvas (behind the drawer) must follow. When the
  // canvas is the active surface, IT is authoritative (canvas → yaml via
  // handleCanvasChange), so a debounced reseed here would spuriously remount the
  // canvas — dropping in-flight canvas state like an open connect modal. Pending
  // edits are flushed on drawer close (see `changeDrawer`).
  useEffect(() => {
    if (openDrawer !== "yaml") return;

    const handle = setTimeout(runYamlSync, YAML_SYNC_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [runYamlSync, openDrawer]);

  // Leaving the YAML drawer flushes the pending yaml→canvas sync FIRST, so the
  // canvas shows the latest edits and the still-pending debounce becomes a no-op.
  const changeDrawer = (next: EditorDrawerKind | null): void => {
    if (openDrawer === "yaml" && next !== "yaml") runYamlSync();
    // eslint-disable-next-line no-console
    console.debug("[flowEditor] drawer", { open: next });
    setOpenDrawer(next);
  };

  const handleCanvasChange = ({ manifest }: { manifest: FlowYamlV1 }): void => {
    canvasManifestRef.current = manifest;
    setLiveManifest(manifest);
    setYaml(stringifyYaml(manifest));
  };

  const canvasReady = canvasAvailable && seed !== null;
  const validation = liveManifest
    ? (() => {
        const r = validateEditorManifest(liveManifest);

        return { ok: r.ok, issueCount: r.issues.length };
      })()
    : null;

  return (
    <form
      action={saveAction}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-paper"
      data-testid="flow-editor-tabs"
      onSubmit={() => {
        // eslint-disable-next-line no-console
        console.debug("[flowEditor] submit", {
          capId,
          expectedDraftVersion: draftVersion,
        });
      }}
    >
      <input name="projectSlug" type="hidden" value={projectSlug} />
      <input name="capId" type="hidden" value={capId} />
      <input name="expectedDraftVersion" type="hidden" value={draftVersion} />
      <input name="flowYaml" type="hidden" value={yaml} />

      <EditorTopBar
        canManage={canManage}
        hasDraft={hasDraft}
        kind={identity.kind}
        labels={labels.topBar}
        lifecycleLabel={lifecycleLabel}
        openDrawer={openDrawer}
        project={identity.project}
        publishAction={publishAction}
        publishDisabled={!readinessReady}
        readinessReady={readinessReady}
        title={title}
        validation={validation}
        onCloseDrawers={() => changeDrawer(null)}
        onTitleChange={setTitle}
        onToggleDrawer={(kind) =>
          changeDrawer(openDrawer === kind ? null : kind)
        }
      />

      {syncError ? (
        <p
          className="border-b border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
          data-testid="flow-yaml-sync-error"
          role="alert"
        >
          {labels.syncError}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0 overflow-hidden"
          data-testid="flow-canvas-pane"
        >
          {canvasReady && seed ? (
            <FlowGraphEditor
              key={seedKey}
              draftVersion={draftVersion}
              initialManifest={seed.manifest}
              inspectorContainer={inspectorContainer}
              labels={labels.editor}
              layout={seed.layout}
              participantSources={participantSources}
              schemaFiles={schemaFiles}
              topology={seed.topology}
              onChange={handleCanvasChange}
              onWriteSchemaFile={onWriteSchemaFile}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center font-mono text-[11px] text-mute">
              {labels.editor.graph.empty || "Open the YAML drawer to edit."}
            </div>
          )}
        </div>

        {openDrawer === "yaml" ? (
          <EditorDrawer
            title={labels.topBar.yaml}
            onClose={() => changeDrawer(null)}
          >
            <div data-testid="flow-yaml-editor">
              <CodeEditor
                ariaLabel="flow.yaml"
                kind="flow"
                readOnly={!canManage}
                value={yaml}
                onChange={setYaml}
              />
            </div>
          </EditorDrawer>
        ) : null}

        {openDrawer === "diff" ? (
          <EditorDrawer
            title={labels.topBar.diff}
            onClose={() => changeDrawer(null)}
          >
            {diffDrawer ?? (
              <FlowDraftDiffText diff={diff} emptyLabel={labels.diffEmpty} />
            )}
          </EditorDrawer>
        ) : null}

        {/* Files: PackageFilesEditor stays MOUNTED (its hidden packageFilesJson
            input must submit with the save form regardless of drawer state);
            only its visibility toggles. */}
        <div
          className={
            openDrawer === "files"
              ? "absolute inset-y-0 right-0 z-10 flex w-full max-w-[640px] flex-col border-l border-line bg-paper shadow-lg"
              : "hidden"
          }
          data-testid="flow-files-drawer"
        >
          {openDrawer === "files" ? (
            <DrawerHeader
              title={labels.topBar.files}
              onClose={() => changeDrawer(null)}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto p-3">{filesDrawer}</div>
        </div>
      </div>
    </form>
  );
}

function DrawerHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
        {title}
      </span>
      <button
        aria-label="close"
        className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-ink-2 hover:bg-ivory"
        data-testid="drawer-close"
        type="button"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}

function EditorDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[640px] flex-col border-l border-line bg-paper shadow-lg"
      data-testid="editor-drawer"
    >
      <DrawerHeader title={title} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}
