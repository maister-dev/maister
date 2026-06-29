"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { PackageBom } from "@/lib/queries/package-bom";
import type { CompositionKind } from "@/lib/local-packages/composition";
import type { ReactElement, ReactNode } from "react";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  FrontmatterArtifactEditor,
  type FrontmatterArtifactKind,
} from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import { McpTemplateEditor } from "@/components/flows/artifact-editors/mcp-template-editor";
import {
  buildGraphLabels,
  FlowPreviewCard,
} from "@/components/studio/package-detail";
import { ElementCard } from "@/components/studio/element-card";
import {
  PackageTabs,
  type PackageTabDescriptor,
} from "@/components/studio/package-tabs";
import { upsertPackageFile } from "@/lib/flows/editor/package-files-draft";
import {
  COMPOSITION_TAB_IDS,
  compositionCounts,
  compositionTabHref,
  flowCanvasHref,
  inlineSelectHref,
  isMcpDescriptorPath,
  listCapabilities,
  resolveCompositionTab,
  resolveInlineFilePath,
  skillScreenHref,
  type CompositionTabId,
} from "@/lib/local-packages/composition";
import {
  scaffoldArtifact,
  type ScaffoldKind,
} from "@/lib/local-packages/scaffold";
import { renameArtifact } from "@/lib/local-packages/rename-artifact";

const TAB_LABEL_KEY: Record<CompositionTabId, string> = {
  flows: "viewer.tabFlows",
  skills: "viewer.tabSkills",
  subagents: "viewer.tabSubagents",
  agents: "viewer.tabAgents",
  mcps: "viewer.tabMcps",
  rules: "viewer.tabRules",
  files: "viewer.tabFiles",
};

// Local composition has small N — render every member (no pagination).
const PACKAGE_TAB_PAGE_SIZE_LOCAL = 10_000;

// The frontmatter-artifact kind each FRONTMATTER inline kind edits as. Only the
// kinds whose inline editor is the frontmatter editor are listed; `mcps` is
// dispatched to McpTemplateEditor (its frontmatterKind is the ignored `?? "rule"`
// fallback) and `flows`/`skills` never open inline, so listing them would be dead.
const FRONTMATTER_KIND_BY_COMPOSITION: Partial<
  Record<CompositionKind, FrontmatterArtifactKind>
> = {
  subagents: "subagent",
  agents: "agent_definition",
  rules: "rule",
};

type TFn = ReturnType<typeof useTranslations>;

// The tabbed-by-kind composition landing for the local-package editor (ADR-116).
// Reuses the installed viewer's PackageTabs + ElementCard + FlowPreviewCard over
// the local BOM. Flows route to the canvas, skills to a dedicated screen, the
// remaining kinds open inline (master-detail: card list + side editor). Files is
// always present and hosts the file-manager (`filesEditor` slot, owned by the
// parent which holds the draft).
export function PackageComposition({
  packageId,
  name,
  bom,
  fileCount,
  readOnly,
  filesEditor,
  draftFiles,
  filesLabels,
  mcpCatalog,
  saveLabel,
  onDraftFilesChange,
  onSaveDraft,
  onCreateArtifact,
}: {
  packageId: string;
  name: string;
  bom: PackageBom;
  fileCount: number;
  readOnly: boolean;
  // The Files-tab content (the parent owns the editable draft + its editor).
  filesEditor: ReactNode;
  // The draft file set + change/save callbacks for the inline editors.
  draftFiles: AuthoredFlowPackageFile[];
  filesLabels: PackageFilesEditorLabels;
  mcpCatalog: PlatformMcpCatalogEntry[];
  saveLabel: string;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSaveDraft: () => void;
  // Persist the scaffolded files then navigate (create = scaffold→save→refresh).
  onCreateArtifact: (
    files: AuthoredFlowPackageFile[],
    navigate: string,
  ) => void;
}): ReactElement {
  const t = useTranslations("studio");
  const tWorkbench = useTranslations("workbench");
  const searchParams = useSearchParams();

  const counts = compositionCounts(bom);
  const activeTab = resolveCompositionTab(searchParams.get("tab"), bom);
  const selectedId = searchParams.get("sel");

  const tabs: PackageTabDescriptor[] = COMPOSITION_TAB_IDS.map((id) => ({
    id,
    label: t(TAB_LABEL_KEY[id]),
    count: id === "files" ? fileCount : counts[id as CompositionKind],
  }));

  const totalForActive =
    activeTab === "files" ? fileCount : counts[activeTab as CompositionKind];

  const cardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };

  const cards = buildCompositionCards({
    packageId,
    activeTab,
    bom,
    cardLabels,
    draftFiles,
    filesEditor,
    filesLabels,
    mcpCatalog,
    saveLabel,
    selectedId,
    readOnly,
    t,
    graphLabels: buildGraphLabels(tWorkbench),
    onDraftFilesChange,
    onSaveDraft,
    onCreateArtifact,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto rounded-xl border border-line bg-paper p-4"
      data-testid="package-composition"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[16px] font-semibold text-ink">{name}</h2>
        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
          {t("localBadge")}
        </span>
        {readOnly ? null : (
          <CreateArtifactControl
            draftFiles={draftFiles}
            packageId={packageId}
            t={t}
            onCreateArtifact={onCreateArtifact}
          />
        )}
      </header>

      <PackageTabs
        activeTab={activeTab}
        cards={cards}
        hrefFor={(tab) =>
          compositionTabHref(packageId, tab as CompositionTabId)
        }
        labels={{
          loadMore: t("viewer.loadMore"),
          next: t("viewer.pageNext"),
          page: t("viewer.page"),
          paginationLabel: t("viewer.paginationLabel"),
          previous: t("viewer.pagePrev"),
          showingCount: t.raw("viewer.showingCount"),
          tabEmpty: t("viewer.tabEmpty"),
        }}
        layout={activeTab === "skills" ? "grid" : "stack"}
        page={1}
        pageSize={PACKAGE_TAB_PAGE_SIZE_LOCAL}
        tabs={tabs}
        totalForActive={totalForActive}
      />
    </div>
  );
}

function buildCompositionCards({
  packageId,
  activeTab,
  bom,
  cardLabels,
  draftFiles,
  filesEditor,
  filesLabels,
  mcpCatalog,
  saveLabel,
  selectedId,
  readOnly,
  t,
  graphLabels,
  onDraftFilesChange,
  onSaveDraft,
  onCreateArtifact,
}: {
  packageId: string;
  activeTab: CompositionTabId;
  bom: PackageBom;
  cardLabels: { view: string; fork: string; forkPhase2Hint: string };
  draftFiles: AuthoredFlowPackageFile[];
  filesEditor: ReactNode;
  filesLabels: PackageFilesEditorLabels;
  mcpCatalog: PlatformMcpCatalogEntry[];
  saveLabel: string;
  selectedId: string | null;
  readOnly: boolean;
  t: TFn;
  graphLabels: ReturnType<typeof buildGraphLabels>;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSaveDraft: () => void;
  onCreateArtifact: (
    files: AuthoredFlowPackageFile[],
    navigate: string,
  ) => void;
}): ReactNode {
  switch (activeTab) {
    case "files":
      return (
        <div data-readonly={readOnly} data-testid="composition-files">
          {filesEditor}
        </div>
      );
    case "flows":
      return bom.flows.map((flow) => (
        <div key={flow.id} className="flex flex-col gap-1.5">
          <FlowPreviewCard
            flow={flow}
            graphLabels={graphLabels}
            href={flowCanvasHref(packageId, flow.path)}
            t={t}
          />
          {readOnly ? null : (
            <RenameControl
              currentName={flow.id}
              labels={renameLabels(t)}
              testidPrefix="composition-flow-rename"
              onSubmit={(newName) =>
                applyRename(
                  {
                    kind: "flows",
                    id: flow.id,
                    path: flow.path,
                    newName,
                    packageId,
                    draftFiles,
                  },
                  t,
                  onCreateArtifact,
                )
              }
            />
          )}
        </div>
      ));
    case "skills":
      return bom.skills.map((skill) => (
        <ElementCard
          key={skill.id}
          clickableCard
          description={skill.description || null}
          href={skillScreenHref(packageId, skill.id)}
          labels={cardLabels}
          meta={t("viewer.skillMeta", {
            files: skill.fileCount,
            subfolders: skill.subfolderCount,
          })}
          name={skill.id}
          showFork={false}
        />
      ));
    default:
      return (
        <InlineMasterDetail
          bom={bom}
          cardLabels={cardLabels}
          draftFiles={draftFiles}
          filesLabels={filesLabels}
          kind={activeTab}
          mcpCatalog={mcpCatalog}
          packageId={packageId}
          readOnly={readOnly}
          saveLabel={saveLabel}
          selectedId={selectedId}
          t={t}
          onCreateArtifact={onCreateArtifact}
          onDraftFilesChange={onDraftFilesChange}
          onSaveDraft={onSaveDraft}
        />
      );
  }
}

// Card-list + side editor for the inline kinds (subagents / agents / mcps /
// rules). The card list links to `?sel=`; the detail panel renders the kind's
// real editor wired to the draft (MCP → McpTemplateEditor; everything else →
// FrontmatterArtifactEditor) plus a Save action.
function InlineMasterDetail({
  packageId,
  kind,
  bom,
  draftFiles,
  filesLabels,
  mcpCatalog,
  readOnly,
  saveLabel,
  selectedId,
  cardLabels,
  t,
  onDraftFilesChange,
  onSaveDraft,
  onCreateArtifact,
}: {
  packageId: string;
  kind: CompositionKind;
  bom: PackageBom;
  draftFiles: AuthoredFlowPackageFile[];
  filesLabels: PackageFilesEditorLabels;
  mcpCatalog: PlatformMcpCatalogEntry[];
  readOnly: boolean;
  saveLabel: string;
  selectedId: string | null;
  cardLabels: { view: string; fork: string; forkPhase2Hint: string };
  t: TFn;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSaveDraft: () => void;
  onCreateArtifact: (
    files: AuthoredFlowPackageFile[],
    navigate: string,
  ) => void;
}): ReactElement {
  const items = inlineItems(kind, bom, t);
  const selectedPath = selectedId
    ? resolveInlineFilePath(kind, selectedId, bom, draftFiles)
    : null;

  return (
    <div
      className="grid gap-3 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]"
      data-testid="composition-master-detail"
    >
      <div className="flex flex-col gap-2" data-testid="composition-card-list">
        {items.map((item) => (
          <ElementCard
            key={item.id}
            clickableCard
            description={item.description}
            href={inlineSelectHref(packageId, kind, item.id)}
            labels={cardLabels}
            meta={item.meta}
            name={item.id}
            showFork={false}
          />
        ))}
      </div>
      <div
        className="min-h-0 rounded-[12px] border border-line bg-ivory p-3"
        data-testid="composition-inline-detail"
      >
        {selectedPath && selectedId ? (
          <div className="flex flex-col gap-3">
            {readOnly ? null : (
              <RenameControl
                currentName={selectedId}
                labels={renameLabels(t)}
                testidPrefix="composition-inline-rename"
                onSubmit={(newName) =>
                  applyRename(
                    {
                      kind,
                      id: selectedId,
                      path: selectedPath,
                      newName,
                      packageId,
                      draftFiles,
                    },
                    t,
                    onCreateArtifact,
                  )
                }
              />
            )}
            <InlineEditor
              draftFiles={draftFiles}
              filePath={selectedPath}
              filesLabels={filesLabels}
              frontmatterKind={FRONTMATTER_KIND_BY_COMPOSITION[kind] ?? "rule"}
              mcpCatalog={mcpCatalog}
              readOnly={readOnly}
              saveLabel={saveLabel}
              onDraftFilesChange={onDraftFilesChange}
              onSaveDraft={onSaveDraft}
            />
          </div>
        ) : (
          <p className="m-0 font-mono text-[11px] text-mute">
            {selectedId
              ? t("composition.notFound")
              : t("composition.selectHint")}
          </p>
        )}
      </div>
    </div>
  );
}

// The single-file inline editor: dispatches MCP descriptors to McpTemplateEditor
// and every other artifact to FrontmatterArtifactEditor (kind inferred from the
// path). `onChange` upserts the draft; Save persists through the parent.
function InlineEditor({
  filePath,
  draftFiles,
  filesLabels,
  frontmatterKind,
  mcpCatalog,
  readOnly,
  saveLabel,
  onDraftFilesChange,
  onSaveDraft,
}: {
  filePath: string;
  draftFiles: AuthoredFlowPackageFile[];
  filesLabels: PackageFilesEditorLabels;
  frontmatterKind: FrontmatterArtifactKind;
  mcpCatalog: PlatformMcpCatalogEntry[];
  readOnly: boolean;
  saveLabel: string;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSaveDraft: () => void;
}): ReactElement {
  const content =
    draftFiles.find((file) => file.path === filePath)?.content ?? "";
  const onChange = (next: string): void =>
    onDraftFilesChange(upsertPackageFile(draftFiles, filePath, next));

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="composition-inline-editor"
    >
      <div className="truncate font-mono text-[11px] text-mute">{filePath}</div>
      {isMcpDescriptorPath(filePath) ? (
        <McpTemplateEditor
          catalog={mcpCatalog}
          content={content}
          fileName={filePath}
          // Invariant: this surface always builds labels with includeMcp=true
          // (studio/edit page). An MCP descriptor must never reach the
          // frontmatter editor — it would mangle the YAML on save.
          labels={filesLabels.mcp!}
          readOnly={readOnly}
          onChange={onChange}
        />
      ) : (
        <FrontmatterArtifactEditor
          content={content}
          kind={frontmatterKind}
          labels={filesLabels.frontmatter}
          readOnly={readOnly}
          onChange={onChange}
        />
      )}
      {readOnly ? null : (
        <button
          className="justify-self-start rounded-md border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
          data-testid="composition-inline-save"
          type="button"
          onClick={onSaveDraft}
        >
          {saveLabel}
        </button>
      )}
    </div>
  );
}

const CREATE_KINDS: ScaffoldKind[] = [
  "flow",
  "skill",
  "subagent",
  "agent",
  "mcp",
  "rule",
];

type RenameLabels = { open: string; confirm: string; cancel: string };

export function renameLabels(t: TFn): RenameLabels {
  return {
    open: t("composition.rename.open"),
    confirm: t("composition.rename.confirm"),
    cancel: t("composition.rename.cancel"),
  };
}

// Run an identity rename and persist+navigate on success; returns a localized
// error message on failure (or null on success), for the RenameControl to show.
export function applyRename(
  opts: Parameters<typeof renameArtifact>[0],
  t: TFn,
  onCreateArtifact: (
    files: AuthoredFlowPackageFile[],
    navigate: string,
  ) => void,
): string | null {
  const result = renameArtifact(opts);

  if (!result.ok) {
    return result.code === "CONFLICT"
      ? t("composition.create.errorConflict")
      : result.code === "CONFIG"
        ? t("composition.create.errorConfig")
        : t("composition.create.errorInvalid");
  }

  onCreateArtifact(result.files, result.navigate);

  return null;
}

// A compact "Rename" affordance: a button that opens a name input + confirm. The
// `onSubmit` returns a localized error message (or null on success); the control
// stays open on error so the user can correct the name (ADR-116 P6).
export function RenameControl({
  currentName,
  labels,
  testidPrefix,
  onSubmit,
}: {
  currentName: string;
  labels: RenameLabels;
  testidPrefix: string;
  onSubmit: (newName: string) => string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        className="self-start rounded-md border border-line px-2.5 py-1 font-mono text-[10.5px] font-semibold text-mute transition-colors hover:border-amber hover:text-ink"
        data-testid={`${testidPrefix}-open`}
        type="button"
        onClick={() => {
          setValue(currentName);
          setError(null);
          setOpen(true);
        }}
      >
        {labels.open}
      </button>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testidPrefix}-form`}
    >
      <input
        aria-label={labels.open}
        className="min-h-[30px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink"
        data-testid={`${testidPrefix}-name`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        className="min-h-[30px] rounded-md border border-amber bg-amber px-2.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
        data-testid={`${testidPrefix}-submit`}
        type="button"
        onClick={() => {
          const err = onSubmit(value);

          if (err) setError(err);
          else setOpen(false);
        }}
      >
        {labels.confirm}
      </button>
      <button
        className="min-h-[30px] rounded-md border border-line px-2.5 font-mono text-[10.5px] font-semibold text-mute hover:text-ink"
        data-testid={`${testidPrefix}-cancel`}
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
      >
        {labels.cancel}
      </button>
      {error ? (
        <span
          className="font-mono text-[10.5px] text-danger"
          data-testid={`${testidPrefix}-error`}
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

// The global "+ Add <kind>" create control (ADR-116 P5). A kind whose tab is
// hidden (empty) is still creatable here. A flow opens the canvas, a skill its
// screen, the rest inline — after the scaffold is saved (create = scaffold →
// save → refresh), so the navigated target reads it off disk.
function CreateArtifactControl({
  packageId,
  draftFiles,
  t,
  onCreateArtifact,
}: {
  packageId: string;
  draftFiles: AuthoredFlowPackageFile[];
  t: TFn;
  onCreateArtifact: (
    files: AuthoredFlowPackageFile[],
    navigate: string,
  ) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ScaffoldKind>("flow");
  const [name, setName] = useState("");
  const capabilities = useMemo(
    () => listCapabilities(draftFiles),
    [draftFiles],
  );
  const [capability, setCapability] = useState(capabilities[0] ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (kind === "subagent" && capability.trim() === "") {
      setError(t("composition.create.errorCapabilityRequired"));

      return;
    }

    const result = scaffoldArtifact({
      kind,
      name,
      packageId,
      draftFiles,
      capability: kind === "subagent" ? capability : undefined,
    });

    if (!result.ok) {
      setError(
        result.code === "CONFLICT"
          ? t("composition.create.errorConflict")
          : result.code === "CONFIG"
            ? t("composition.create.errorConfig")
            : t("composition.create.errorInvalid"),
      );

      return;
    }

    setOpen(false);
    setName("");
    setError(null);
    onCreateArtifact(result.files, result.navigate);
  };

  if (!open) {
    return (
      <button
        className="ml-auto rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-amber"
        data-testid="composition-create-open"
        type="button"
        onClick={() => setOpen(true)}
      >
        + {t("composition.create.open")}
      </button>
    );
  }

  return (
    <div
      className="ml-auto flex flex-wrap items-center gap-2"
      data-testid="composition-create-form"
    >
      <select
        aria-label={t("composition.create.kindLabel")}
        className="min-h-[32px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink"
        data-testid="composition-create-kind"
        value={kind}
        onChange={(event) => setKind(event.target.value as ScaffoldKind)}
      >
        {CREATE_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`composition.create.kind.${k}`)}
          </option>
        ))}
      </select>
      <input
        aria-label={t("composition.create.name")}
        className="min-h-[32px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink"
        data-testid="composition-create-name"
        placeholder={t("composition.create.name")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {kind === "subagent" ? (
        <input
          aria-label={t("composition.create.capability")}
          className="min-h-[32px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink"
          data-testid="composition-create-capability"
          list="composition-capabilities"
          placeholder={t("composition.create.capability")}
          value={capability}
          onChange={(event) => setCapability(event.target.value)}
        />
      ) : null}
      <datalist id="composition-capabilities">
        {capabilities.map((cap) => (
          <option key={cap} value={cap} />
        ))}
      </datalist>
      <button
        className="min-h-[32px] rounded-md border border-amber bg-amber px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
        data-testid="composition-create-submit"
        type="button"
        onClick={submit}
      >
        {t("composition.create.create")}
      </button>
      <button
        className="min-h-[32px] rounded-md border border-line px-3 font-mono text-[11px] font-semibold text-mute hover:text-ink"
        data-testid="composition-create-cancel"
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
      >
        {t("composition.create.cancel")}
      </button>
      {error ? (
        <span
          className="font-mono text-[10.5px] text-danger"
          data-testid="composition-create-error"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

type InlineItem = {
  id: string;
  description: string | null;
  meta: string | null;
};

function inlineItems(
  kind: CompositionKind,
  bom: PackageBom,
  t: TFn,
): InlineItem[] {
  switch (kind) {
    case "subagents":
      return bom.subagents.map((s) => ({
        id: s.id,
        description: s.description || t("viewer.subagentNoDescription"),
        meta: s.path,
      }));
    case "agents":
      return bom.platformAgents.map((a) => ({
        id: a.id,
        description: a.description || null,
        meta: a.path,
      }));
    case "mcps":
      return bom.mcps.map((m) => ({ id: m.id, description: null, meta: null }));
    case "rules":
      return bom.rules.map((r) => ({
        id: r.id,
        description: null,
        meta: r.path,
      }));
    default:
      return [];
  }
}
