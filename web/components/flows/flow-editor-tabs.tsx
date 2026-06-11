"use client";

import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/flows/graph/topology";
import type { ReactElement, ReactNode } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { stringify as stringifyYaml } from "yaml";

import { CodeEditor } from "@/components/flows/code-editor";
import { FlowDraftDiffText } from "@/components/flows/flow-draft-diff";
import { syncYamlToCanvas } from "@/lib/flows/editor/yaml-sync";

const YAML_SYNC_DEBOUNCE_MS = 400;

// ReactFlow does not SSR cleanly — mount the canvas client-only, mirroring the
// read-only M22 FlowGraphView (dynamic ssr:false).
const FlowGraphEditor = dynamic(
  () => import("@/components/flows/flow-graph-editor"),
  { ssr: false },
);

export type FlowEditorTabsLabels = {
  graphTab: string;
  yamlTab: string;
  diffTab: string;
  diffEmpty: string;
  syncError: string;
  editor: FlowGraphEditorLabels;
};

type Tab = "graph" | "yaml" | "diff";

/**
 * M27/T-A8 + T3.3: the editing surface inside the authored-flow form, the SINGLE
 * owner of the manifest state (spec §4.5). A single `flowYaml` value drives all
 * tabs and is carried by the hidden `name="flowYaml"` input so the existing
 * `updateAuthoredFlowAction` save path is reused unchanged.
 *
 * Live YAML↔canvas sync: a debounced effect parses the `yaml` buffer; a valid,
 * structurally-different manifest re-seeds the canvas (`seedKey` remount), a
 * parse/validate error keeps the last-good graph + shows an inline banner, and a
 * manifest equal to what the canvas last serialized is a no-op. Canvas edits
 * serialize back into the SAME `yaml` state; that write is recorded as the
 * canvas's current manifest so the ensuing debounced parse diffs equal → no
 * reseed (loop guard — both the wiring record AND the reducer's idempotent diff
 * close the canvas→serialize→reseed cycle).
 */
export function FlowEditorTabs({
  initialYaml,
  initialManifest,
  topology,
  layout,
  draftVersion,
  diff,
  labels,
  disabled,
  canvasAvailable,
}: {
  initialYaml: string;
  initialManifest: FlowYamlV1 | null;
  topology: GraphTopology | null;
  layout: FlowLayout | null;
  draftVersion: number;
  diff: string;
  labels: FlowEditorTabsLabels;
  disabled: boolean;
  canvasAvailable: boolean;
}): ReactElement {
  const [yaml, setYaml] = useState(initialYaml);
  const [tab, setTab] = useState<Tab>(canvasAvailable ? "graph" : "yaml");

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

  // The manifest the canvas currently reflects: its last-serialized or
  // last-seeded state. The debounced reducer diffs the parsed yaml against this
  // to decide reseed-vs-noop. A canvas onChange updates it BEFORE setYaml so the
  // debounce that follows sees equality and does not bounce the canvas.
  const canvasManifestRef = useRef<FlowYamlV1 | null>(initialManifest);

  // Apply the current yaml buffer to the canvas seed: reseed on a structurally
  // different manifest, keep last-good + flag the banner on a parse/validate
  // error, no-op when the manifest equals what the canvas last serialized.
  const runYamlSync = useCallback(() => {
    const decision = syncYamlToCanvas(yaml, canvasManifestRef.current);

    if (decision.kind === "noop") {
      setSyncError(false);

      return;
    }

    if (decision.kind === "error") {
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
    setSyncError(false);
  }, [yaml]);

  useEffect(() => {
    const handle = setTimeout(runYamlSync, YAML_SYNC_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [runYamlSync]);

  // Entering the graph tab flushes the pending yaml→canvas sync FIRST, so the
  // canvas mounts with the latest edits and the still-pending debounce becomes a
  // no-op — no mid-interaction remount on a quick tab switch (Reviewer M2).
  const selectTab = (next: Tab): void => {
    if (next === "graph") runYamlSync();
    setTab(next);
  };

  const handleCanvasChange = ({ manifest }: { manifest: FlowYamlV1 }): void => {
    canvasManifestRef.current = manifest;
    setYaml(stringifyYaml(manifest));
  };

  const canvasReady = canvasAvailable && seed !== null;

  return (
    <div className="grid gap-3" data-testid="flow-editor-tabs">
      <input name="flowYaml" type="hidden" value={yaml} />

      <div className="flex flex-wrap gap-1.5">
        {canvasAvailable ? (
          <TabButton
            active={tab === "graph"}
            testid="flow-tab-graph"
            onClick={() => selectTab("graph")}
          >
            {labels.graphTab}
          </TabButton>
        ) : null}
        <TabButton
          active={tab === "yaml"}
          testid="flow-tab-yaml"
          onClick={() => selectTab("yaml")}
        >
          {labels.yamlTab}
        </TabButton>
        {canvasAvailable ? (
          <TabButton
            active={tab === "diff"}
            testid="flow-tab-diff"
            onClick={() => selectTab("diff")}
          >
            {labels.diffTab}
          </TabButton>
        ) : null}
      </div>

      {syncError ? (
        <p
          className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
          data-testid="flow-yaml-sync-error"
          role="alert"
        >
          {labels.syncError}
        </p>
      ) : null}

      {tab === "graph" && canvasReady && seed ? (
        <FlowGraphEditor
          key={seedKey}
          draftVersion={draftVersion}
          initialManifest={seed.manifest}
          labels={labels.editor}
          layout={seed.layout}
          topology={seed.topology}
          onChange={handleCanvasChange}
        />
      ) : null}

      {tab === "yaml" ? (
        <div data-testid="flow-yaml-editor">
          <CodeEditor
            ariaLabel="flow.yaml"
            kind="flow"
            readOnly={disabled}
            value={yaml}
            onChange={setYaml}
          />
        </div>
      ) : null}

      {tab === "diff" ? (
        <FlowDraftDiffText diff={diff} emptyLabel={labels.diffEmpty} />
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  testid,
  onClick,
  children,
}: {
  active: boolean;
  testid: string;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      className={
        active
          ? "rounded-md border border-amber-line bg-amber-soft px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber"
          : "rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-ivory"
      }
      data-testid={testid}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
