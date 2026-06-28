"use client";

import type { FlowEditorTabsLabels } from "@/components/flows/flow-editor-tabs";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { ScratchHeaderInfo } from "@/components/scratch/scratch-conversation";
import type { LocalPackageDiffLabels } from "@/components/studio/local-package-diff-drawer";
import type { DiffViewLabels } from "@/components/workbench/diff-view";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  AssistantRunnerSource,
  ReferenceSourceGroup,
} from "@/lib/flows/editor/reference-sources";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { LockState } from "@/lib/local-packages/lock";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement, ReactNode } from "react";
import type { PackageBom } from "@/lib/queries/package-bom";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { PackageComposition } from "@/components/studio/package-composition";
import { LocalPackageDiffDrawer } from "@/components/studio/local-package-diff-drawer";
import {
  ChangeReviewDialog,
  type ChangeReviewDialogLabels,
} from "@/components/studio/change-review-dialog";
import { PublishDialog } from "@/components/studio/publish-dialog";
import {
  StudioAiTab,
  type StudioAiTabLabels,
} from "@/components/studio/studio-ai-tab";
import {
  buildImportDialogLabels,
  ImportDialog,
} from "@/components/studio/import-dialog";
import { readApiError } from "@/lib/api-error";
import { buildPackageCapabilityCatalog } from "@/lib/capabilities/package-catalog";
import { isMaisterError } from "@/lib/errors-core";
import {
  packageFilesToSubmitValue,
  upsertPackageFile,
} from "@/lib/flows/editor/package-files-draft";
import {
  buildAgentGroupFromFiles,
  buildMcpOptions,
  buildRunnerGroup,
  buildSkillOptions,
} from "@/lib/flows/editor/reference-sources";
import {
  overlayFlowBuffer,
  parsePackageFilesJson,
  planWorkingDirWrites,
} from "@/lib/local-packages/working-dir-save";
import { PACKAGE_MANIFEST_FILENAME } from "@/lib/local-packages/manifest";

// Client-projected lock state (Date → ISO string for the RSC boundary).
export type LockSnapshot = {
  held: boolean;
  heldByMe: boolean;
  holderLabel: string | null;
};

type AssistantRunnersResponse = {
  runners: AssistantRunnerSource[];
  defaultRunnerId?: string | null;
};

export type LocalPackageEditorLabels = {
  editor: FlowEditorTabsLabels;
  readOnlyHeld: string; // non-ICU "Locked by $holder — read-only."
  readOnlyUnknownHolder: string;
  lockLost: string;
  reload: string;
  saving: string;
  saved: string;
  saveFailed: string;
  // The git-backed [Diff] drawer (working-tree-vs-HEAD + Commit/Discard).
  diff: LocalPackageDiffLabels;
  diffView: DiffViewLabels;
  // M36 T5.7: the bottom assistant panel.
  tabAi: string;
  aiWorking: string;
  aiCollapse: string;
  aiExpand: string;
  ai: StudioAiTabLabels;
  // The Files-tab save button label (the composition landing replaced the old
  // package-home; ADR-115).
  home: { save: string };
  crumbStudio: string;
  crumbLocal: string;
  endEdit: string;
  // M39 (A3): the prominent top-bar "Commit state" action + the shared review
  // dialog (diff + commit message + the commit-gate invalid-artifact list).
  commitState: string;
  changeReview: ChangeReviewDialogLabels;
};

// Keep-alive cadence. The server lock TTL defaults to 30 min
// (MAISTER_LOCAL_PACKAGE_LOCK_MINUTES); refreshing every 60s keeps it live with
// a wide safety margin and is cheap (one row UPDATE).
const LOCK_REFRESH_MS = 60_000;

function releaseEditorLock(packageId: string, sessionId: string): void {
  const url = `/api/studio/local-packages/${packageId}/lock-release`;
  const body = JSON.stringify({ sessionId });

  if (typeof navigator.sendBeacon === "function") {
    const queued = navigator.sendBeacon(
      url,
      new Blob([body], { type: "application/json" }),
    );

    if (queued) return;
  }

  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch((err: unknown) => {
    console.warn("local-package lock release failed", { packageId, err });
  });
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

/**
 * The /studio/edit editor shell (M36 T2.4). Mounts the SHARED FlowEditorTabs via
 * its injectable seam with a WORKING-DIR save action — no draft-version CAS; the
 * session edit-lock plus git are the concurrency model.
 *
 * Lock flow:
 *  - a per-mount `sessionId` is generated client-side and acquired on open via
 *    POST /lock-refresh (mode=acquire); a keep-alive timer refreshes only that
 *    same session.
 *  - `heldByMe === false` (another user holds a live lock) → read-only banner
 *    + the editor renders with `canManage=false`.
 *  - every write goes through PUT/DELETE /files, which asserts the lock; a
 *    CONFLICT (expired / taken over) surfaces a "reload" banner.
 *  - unmount/pagehide releases the lock; same-user reopen can also take over a
 *    stale tab session.
 *
 * `working_dir` never reaches this client — only the file list/content DTOs do.
 */
export function LocalPackageEditor({
  packageId,
  canManage,
  initialLock,
  initialTitle,
  identity,
  flowPath,
  initialYaml,
  initialManifest,
  topology,
  layout,
  diff,
  canvasAvailable,
  files,
  bom,
  labels,
  filesLabels,
  fileKindLabels,
  mcpCatalog,
}: {
  packageId: string;
  canManage: boolean;
  initialLock: LockSnapshot;
  initialTitle: string;
  identity: { project: string; slug: string; kind: string };
  // The working-dir path of the flow file the canvas edits (when the route
  // targets a `flows/*` / `flow.yaml` file); null when no flow is selected.
  flowPath: string | null;
  initialYaml: string;
  initialManifest: FlowYamlV1 | null;
  topology: GraphTopology | null;
  layout: FlowLayout | null;
  diff: string;
  canvasAvailable: boolean;
  files: AuthoredFlowPackageFile[];
  // Server-computed bill-of-materials from the last-saved working dir (ADR-115),
  // driving the tabbed composition landing.
  bom: PackageBom;
  labels: LocalPackageEditorLabels;
  // The PackageFilesEditor is built HERE (not handed in) so its read-only state
  // tracks the live lock — a lost/foreign lock disables editing, not just
  // saving. Props are plain data (RSC-serializable); no function crosses the
  // server→client boundary.
  filesLabels: PackageFilesEditorLabels;
  fileKindLabels: Record<AuthoredFlowPackageFileKind, string>;
  mcpCatalog: PlatformMcpCatalogEntry[];
}): ReactElement {
  const router = useRouter();
  const tApiErrors = useTranslations("apiErrors");
  const tStudio = useTranslations("studio");
  const tPublish = useTranslations("publishDialog");
  const [importing, setImporting] = useState(false);

  // Stable per-mount session id (survives re-renders; never the lock-holder
  // label). Generated lazily so SSR and the first client render agree (the ref
  // is only read in effects / event handlers, after hydration).
  const sessionIdRef = useRef<string>("");

  if (sessionIdRef.current === "") {
    sessionIdRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `lp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const [lockHeldByMe, setLockHeldByMe] = useState(initialLock.heldByMe);
  const [lockConfirmedByMe, setLockConfirmedByMe] = useState(false);
  const [holderLabel, setHolderLabel] = useState(initialLock.holderLabel);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  // Bumped after a successful save or import so the git-diff drawer re-fetches
  // the working-tree diff + its changed-count.
  const [diffRefresh, setDiffRefresh] = useState(0);
  // M36 T5.7: while the assistant holds a turn the human editor is read-only;
  // control returns on turn end (assistantBusy → false).
  const [assistantBusy, setAssistantBusy] = useState(false);
  // The AI assistant now lives in a right-hand drawer that shares the single
  // right slot with the node-properties inspector (mutually exclusive): opening
  // it hides the inspector; selecting a node in the graph closes it again.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiHeader, setAiHeader] = useState<ScratchHeaderInfo | null>(null);
  const [inspectorEl, setInspectorEl] = useState<HTMLDivElement | null>(null);
  const [flowEditorDirty, setFlowEditorDirty] = useState(false);
  const [packageFilesDirty, setPackageFilesDirty] = useState(false);
  const [draftFiles, setDraftFiles] = useState(files);
  // M39 A3: the working-tree dirty count drives the top-bar "Commit state" badge
  // and the review dialog. Tracked here (not only in the flow-editor diff drawer)
  // so the badge works on the package-home view too, where the drawer is absent.
  const [changedCount, setChangedCount] = useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [runnerSources, setRunnerSources] = useState<AssistantRunnerSource[]>(
    [],
  );
  // On any assistant stream activity, re-read the working dir: the canvas
  // (router.refresh re-runs the server compile) and the git-diff drawer's
  // changed-count (diffRefresh) reflect files the assistant just wrote.
  const onAssistantActivity = useCallback((): void => {
    setDiffRefresh((n) => n + 1);
    router.refresh();
  }, [router]);

  // The AI drawer and the node-properties inspector are mutually exclusive in
  // the single right slot: picking a node hands the slot back to the inspector.
  const handleNodeSelected = useCallback((nodeId: string | null): void => {
    if (nodeId !== null) setAiOpen(false);
  }, []);

  const applyLock = useCallback((lock: LockState | LockSnapshot): void => {
    setLockHeldByMe(lock.heldByMe);
    setHolderLabel(lock.holderLabel ?? null);
  }, []);

  // M39: explicit "Done / End edit" — release the lock now (the unmount cleanup
  // also releases, idempotently) and return to the local-package list.
  const endEdit = useCallback((): void => {
    releaseEditorLock(packageId, sessionIdRef.current);
    router.push("/studio/local");
  }, [packageId, router]);

  // Acquire on open + keep-alive heartbeat. A failed refresh degrades to
  // read-only rather than throwing — the next write's lock assertion is the
  // hard gate.
  useEffect(() => {
    let cancelled = false;
    const sessionId = sessionIdRef.current;

    setLockConfirmedByMe(false);

    const syncLock = async (mode: "acquire" | "refresh"): Promise<void> => {
      try {
        const res = await fetch(
          `/api/studio/local-packages/${packageId}/lock-refresh`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, mode }),
          },
        );

        if (cancelled) return;
        if (!res.ok) {
          setLockHeldByMe(false);
          setLockConfirmedByMe(false);

          return;
        }
        const lock = (await res.json()) as LockState;

        applyLock(lock);
        setLockConfirmedByMe(lock.heldByMe);
      } catch {
        if (!cancelled) {
          setLockHeldByMe(false);
          setLockConfirmedByMe(false);
        }
      }
    };
    const release = (): void => releaseEditorLock(packageId, sessionId);
    const releaseOnPageHide = (event: PageTransitionEvent): void => {
      if (!event.persisted) release();
    };

    window.addEventListener("pagehide", releaseOnPageHide);
    void syncLock("acquire");
    const handle = setInterval(() => void syncLock("refresh"), LOCK_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(handle);
      window.removeEventListener("pagehide", releaseOnPageHide);
      release();
    };
  }, [packageId, applyLock]);

  // Track the working-tree changed-count for the Commit-state badge. Re-runs on
  // diffRefresh (after any save / import / commit). A failed fetch leaves the
  // badge unset rather than throwing.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/studio/local-packages/${packageId}/diff`);

        if (!res.ok || cancelled) return;

        const data = (await res.json()) as { changedCount: number };

        if (!cancelled) setChangedCount(data.changedCount);
      } catch {
        // ignore — the badge stays unset
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [packageId, diffRefresh]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(
          `/api/studio/local-packages/${packageId}/assistant/runners`,
        );

        if (cancelled) return;

        if (!res.ok) {
          setRunnerSources([]);

          return;
        }

        const data = (await res.json()) as AssistantRunnersResponse;

        if (!cancelled) setRunnerSources(data.runners);
      } catch {
        if (!cancelled) setRunnerSources([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [packageId]);

  useEffect(() => {
    if (!packageFilesDirty) setDraftFiles(files);
  }, [files, packageFilesDirty]);

  // The working-dir save action injected into FlowEditorTabs. It runs inside the
  // editor's own <form>, so it receives the submitted blob; it diffs against the
  // originals and emits the minimal PUT/DELETE set, each lock-guarded server-side.
  const originalRef = useRef(files);

  originalRef.current = files;

  // Mirrors the FlowEditorTabs flow-YAML buffer so `flushBeforeAssistant` can
  // persist unsaved flow edits without owning the buffer state.
  const flowYamlRef = useRef(initialYaml);
  const handleYamlChange = useCallback((value: string): void => {
    flowYamlRef.current = value;
  }, []);

  const handleDraftFilesChange = useCallback(
    (next: AuthoredFlowPackageFile[]): void => {
      setDraftFiles(next);
      setPackageFilesDirty(
        packageFilesToSubmitValue(next) !==
          packageFilesToSubmitValue(originalRef.current),
      );
    },
    [],
  );
  const schemaFiles = useMemo(
    () =>
      draftFiles
        .filter(
          (file) =>
            file.path.startsWith("schemas/") && file.path.endsWith(".json"),
        )
        .map((file) => ({ path: file.path, content: file.content })),
    [draftFiles],
  );
  const handleWriteSchemaFile = useCallback(
    (path: string, content: string): void => {
      handleDraftFilesChange(upsertPackageFile(draftFiles, path, content));
    },
    [draftFiles, handleDraftFilesChange],
  );

  const runSave = useCallback(
    async (formData: FormData): Promise<boolean> => {
      setStatus({ kind: "saving" });

      const submitted = overlayFlowBuffer(
        parsePackageFilesJson(
          formData.get("packageFilesJson"),
          originalRef.current,
        ),
        flowPath,
        String(formData.get("flowYaml") ?? ""),
      );
      const writes = planWorkingDirWrites(
        originalRef.current.map((f) => ({ path: f.path, content: f.content })),
        submitted,
      );
      const title = String(formData.get("title") ?? "").trim();

      try {
        for (const write of writes) {
          const res =
            write.op === "put"
              ? await fetch(
                  `/api/studio/local-packages/${packageId}/files/${encodePath(
                    write.path,
                  )}`,
                  {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      sessionId: sessionIdRef.current,
                      content: write.content,
                    }),
                  },
                )
              : await fetch(
                  `/api/studio/local-packages/${packageId}/files/${encodePath(
                    write.path,
                  )}`,
                  {
                    method: "DELETE",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionId: sessionIdRef.current }),
                  },
                );

          if (!res.ok) {
            const code = await peekErrorCode(res);

            if (code === "CONFLICT") {
              setLockHeldByMe(false);
              setStatus({ kind: "conflict" });

              return false;
            }
            setStatus({
              kind: "error",
              message: await readApiError(res, tApiErrors),
            });

            return false;
          }
        }

        if (title.length > 0 && title !== initialTitle) {
          const res = await fetch(`/api/studio/local-packages/${packageId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: title }),
          });

          if (!res.ok) {
            setStatus({
              kind: "error",
              message: await readApiError(res, tApiErrors),
            });

            return false;
          }
        }

        setStatus({ kind: "saved" });
        setFlowEditorDirty(false);
        setPackageFilesDirty(false);
        setDiffRefresh((n) => n + 1);
        router.refresh();

        return true;
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            isMaisterError(err) || err instanceof Error
              ? err.message
              : String(err),
        });

        return false;
      }
    },
    [packageId, flowPath, initialTitle, router, tApiErrors],
  );

  const saveAction = useCallback(
    async (formData: FormData): Promise<void> => {
      await runSave(formData);
    },
    [runSave],
  );

  // Persist the current draft file set without a form submit — used by the
  // composition inline editors' Save action (ADR-115).
  const saveDraft = useCallback((): void => {
    const formData = new FormData();

    formData.set("packageFilesJson", packageFilesToSubmitValue(draftFiles));
    formData.set("title", initialTitle);
    void runSave(formData);
  }, [draftFiles, initialTitle, runSave]);

  // The assistant edits files on DISK, so before each turn the unsaved editor
  // buffer (flow YAML + package files) is flushed there first — this replaces the
  // old "save before using the assistant" gate. A failed flush aborts the send.
  const flushBeforeAssistant = useCallback(async (): Promise<boolean> => {
    if (!flowEditorDirty && !packageFilesDirty) return true;

    const formData = new FormData();

    formData.set("flowYaml", flowYamlRef.current);
    formData.set("packageFilesJson", packageFilesToSubmitValue(draftFiles));
    formData.set("title", initialTitle);

    return runSave(formData);
  }, [draftFiles, flowEditorDirty, initialTitle, packageFilesDirty, runSave]);

  // Editing is blocked when the lock is foreign/lost OR the assistant holds a
  // turn ("AI working"). The assistant writes as the lock holder; the human
  // editor steps back until the turn ends.
  const readOnly = !canManage || !lockHeldByMe || assistantBusy;
  const participantSources = useMemo<ReferenceSourceGroup[]>(() => {
    const consensusLabels = labels.editor.editor.nodeForm.consensus;
    const runnerGroup = {
      ...buildRunnerGroup(runnerSources),
      label: consensusLabels.runnersGroup,
    };
    const agentGroup = {
      ...buildAgentGroupFromFiles(identity.project, draftFiles),
      label: consensusLabels.agentsGroup,
    };

    return [runnerGroup, agentGroup];
  }, [
    draftFiles,
    identity.project,
    labels.editor.editor.nodeForm.consensus.agentsGroup,
    labels.editor.editor.nodeForm.consensus.runnersGroup,
    runnerSources,
  ]);
  // The flow/package default runner's adapter (fallback claude) drives the
  // `/`-autosuggest wire form (claude `/` vs codex `$`) for the node-prompt
  // composer; the catalog is derived client-side from the package's own skills.
  const promptAdapter = useMemo<AdapterId>(
    () =>
      (runnerSources.find((runner) => runner.isDefault)?.adapter ??
        runnerSources[0]?.adapter ??
        "claude") as AdapterId,
    [runnerSources],
  );
  const promptCatalog = useMemo(
    () => buildPackageCapabilityCatalog(draftFiles, promptAdapter),
    [draftFiles, promptAdapter],
  );
  const skillOptions = useMemo(
    () => buildSkillOptions(draftFiles),
    [draftFiles],
  );
  const mcpOptions = useMemo(() => buildMcpOptions(mcpCatalog), [mcpCatalog]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <nav
        aria-label="breadcrumb"
        className="flex shrink-0 items-center justify-between gap-2"
      >
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-mute">
          <Link className="hover:text-ink" href="/studio">
            {labels.crumbStudio}
          </Link>
          <span aria-hidden>›</span>
          <Link className="hover:text-ink" href="/studio/local">
            {labels.crumbLocal}
          </Link>
          <span aria-hidden>›</span>
          <span
            className="truncate text-ink"
            data-testid="local-editor-crumb-name"
          >
            {initialTitle}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canManage ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-50"
              data-testid="local-editor-commit-state"
              disabled={readOnly || (changedCount ?? 0) === 0}
              title={labels.commitState}
              type="button"
              onClick={() => setReviewOpen(true)}
            >
              <span aria-hidden>⎇</span>
              <span>{labels.commitState}</span>
              {changedCount && changedCount > 0 ? (
                <span
                  className="rounded-full bg-amber px-1.5 text-[10px] font-bold text-white"
                  data-testid="local-editor-dirty"
                >
                  {changedCount}
                </span>
              ) : null}
            </button>
          ) : null}
          {canManage ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-50"
              data-testid="local-editor-publish"
              disabled={readOnly}
              title={tPublish("openButton")}
              type="button"
              onClick={() => setPublishOpen(true)}
            >
              <span aria-hidden>↥</span>
              <span>{tPublish("openButton")}</span>
            </button>
          ) : null}
          {flowPath !== null ? (
            <button
              aria-pressed={aiOpen}
              className={`inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                aiOpen
                  ? "border-amber bg-amber-soft text-amber"
                  : "border-line bg-ivory text-ink hover:border-amber"
              }`}
              data-testid="local-editor-ai-toggle"
              title={labels.tabAi}
              type="button"
              onClick={() => setAiOpen((open) => !open)}
            >
              <SparklesIcon aria-hidden className="h-3.5 w-3.5" />
              <span>{labels.tabAi}</span>
              {assistantBusy ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-amber"
                  data-testid="local-editor-ai-toggle-busy"
                />
              ) : null}
            </button>
          ) : null}
          <button
            className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-amber"
            data-testid="local-editor-end-edit"
            type="button"
            onClick={endEdit}
          >
            {labels.endEdit}
          </button>
        </div>
      </nav>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <LockBanner
            holderLabel={holderLabel}
            labels={labels}
            lockHeldByMe={lockHeldByMe}
            status={status}
            onReload={() => router.refresh()}
          />
        </div>
        {assistantBusy ? (
          <span
            className="shrink-0 rounded-full border border-amber-line bg-amber-soft px-2.5 py-1 font-mono text-[10.5px] font-semibold text-amber"
            data-testid="local-editor-ai-working"
            role="status"
          >
            {labels.aiWorking}
          </span>
        ) : null}
        <button
          className="shrink-0 rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-50"
          data-testid="local-editor-import"
          disabled={readOnly}
          type="button"
          onClick={() => setImporting(true)}
        >
          ⤓ {tStudio("import.action")}
        </button>
      </div>

      {importing ? (
        <ImportDialog
          labels={buildImportDialogLabels(tStudio)}
          packageId={packageId}
          sessionId={sessionIdRef.current}
          onClose={() => setImporting(false)}
          onImported={() => {
            setDiffRefresh((n) => n + 1);
            router.refresh();
          }}
        />
      ) : null}

      {reviewOpen ? (
        <ChangeReviewDialog
          diffViewLabels={labels.diffView}
          labels={labels.changeReview}
          packageId={packageId}
          sessionId={sessionIdRef.current}
          onClose={() => setReviewOpen(false)}
          onCommitted={() => {
            setDiffRefresh((n) => n + 1);
            router.refresh();
          }}
        />
      ) : null}

      {publishOpen ? (
        <PublishDialog
          packageId={packageId}
          onClose={() => setPublishOpen(false)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1">
          {flowPath === null ? (
            <PackageComposition
              bom={bom}
              draftFiles={draftFiles}
              fileCount={draftFiles.length}
              filesEditor={
                <form action={saveAction} className="grid min-h-0 gap-3">
                  <PackageFilesEditor
                    disabled={readOnly}
                    files={draftFiles}
                    initialSelectedPath={PACKAGE_MANIFEST_FILENAME}
                    kindLabels={fileKindLabels}
                    labels={filesLabels}
                    mcpCatalog={mcpCatalog}
                    onFilesChange={handleDraftFilesChange}
                  />
                  {readOnly ? null : (
                    <button
                      className="justify-self-start rounded-md border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
                      data-testid="composition-files-save"
                      type="submit"
                    >
                      {labels.home.save}
                    </button>
                  )}
                </form>
              }
              filesLabels={filesLabels}
              mcpCatalog={mcpCatalog}
              name={identity.project}
              packageId={packageId}
              readOnly={readOnly}
              saveLabel={labels.home.save}
              onDraftFilesChange={handleDraftFilesChange}
              onSaveDraft={saveDraft}
            />
          ) : (
            <FlowEditorTabs
              canManage={!readOnly}
              canvasAvailable={canvasAvailable}
              capId={identity.slug}
              diff={diff}
              diffDrawer={
                <LocalPackageDiffDrawer
                  canManage={!readOnly}
                  diffViewLabels={labels.diffView}
                  labels={labels.diff}
                  packageId={packageId}
                  refreshSignal={diffRefresh}
                  sessionId={sessionIdRef.current}
                  onChanged={setChangedCount}
                />
              }
              draftVersion={0}
              filesDrawer={
                <PackageFilesEditor
                  disabled={readOnly}
                  files={draftFiles}
                  kindLabels={fileKindLabels}
                  labels={filesLabels}
                  mcpCatalog={mcpCatalog}
                  onFilesChange={handleDraftFilesChange}
                />
              }
              hasDraft={false}
              identity={identity}
              initialManifest={canvasAvailable ? initialManifest : null}
              initialTitle={initialTitle}
              initialYaml={initialYaml}
              inspectorContainer={inspectorEl}
              labels={labels.editor}
              layout={layout}
              lifecycleLabel={identity.kind}
              mcpOptions={mcpOptions}
              participantSources={participantSources}
              projectSlug={identity.slug}
              promptAdapter={promptAdapter}
              promptCatalog={promptCatalog}
              publishAction={saveAction}
              readinessReady={false}
              saveAction={saveAction}
              schemaFiles={schemaFiles}
              skillOptions={skillOptions}
              topology={topology}
              onDirtyChange={setFlowEditorDirty}
              onSelectNode={handleNodeSelected}
              onWriteSchemaFile={handleWriteSchemaFile}
              onYamlChange={handleYamlChange}
            />
          )}
        </div>

        {/* Single right slot. The node-properties inspector portals into
            `inspectorEl`; opening the AI drawer hides that portal target and
            shows the chat instead (mutually exclusive). Both subtrees stay
            MOUNTED and toggle via `hidden` — the chat keeps its live run across
            open/close, and React Flow's createPortal target never tears down. */}
        <aside
          className={
            aiOpen
              ? "flex w-[clamp(420px,34vw,560px)] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-paper"
              : "flex min-h-0 shrink-0"
          }
          data-testid="local-editor-right-slot"
        >
          {/* Mounted only once a flow is open — the AI assistant targets a flow
              file. Hidden (not unmounted) while the inspector shows. */}
          {flowPath !== null ? (
            <div
              className={aiOpen ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              data-testid="local-editor-ai-panel"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {labels.tabAi}
                  </h2>
                  {aiHeader ? (
                    <span
                      className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] ${
                        aiHeader.status === "Crashed"
                          ? "border-[#d9534f]/40 bg-[#d9534f]/10 text-[#d9534f]"
                          : ["Done", "Review", "WaitingForUser"].includes(
                                aiHeader.status,
                              )
                            ? "border-accent-4 bg-accent-4-soft text-accent-4"
                            : aiHeader.status === "Abandoned"
                              ? "border-line bg-ivory text-mute"
                              : "border-amber-line bg-amber-soft text-amber"
                      }`}
                      data-testid="local-editor-ai-header-status"
                    >
                      {aiHeader.statusLabel}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {aiHeader?.usage ? (
                    <span
                      className="flex items-center gap-1.5 font-mono text-[9.5px] text-mute"
                      data-testid="local-editor-ai-header-summary"
                    >
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-ivory">
                        <span
                          className="block h-full bg-amber"
                          style={{
                            width: `${Math.min(100, Math.round((aiHeader.usage.used / Math.max(1, aiHeader.usage.size)) * 100))}%`,
                          }}
                        />
                      </span>
                      <span>
                        {aiHeader.usage.used.toLocaleString()} /{" "}
                        {aiHeader.usage.size.toLocaleString()}
                      </span>
                    </span>
                  ) : null}
                  {assistantBusy ? (
                    <span
                      className="rounded-full border border-amber-line bg-amber-soft px-2 py-0.5 font-mono text-[10px] font-semibold text-amber"
                      data-testid="local-editor-ai-working-panel"
                      role="status"
                    >
                      {labels.aiWorking}
                    </span>
                  ) : null}
                  <button
                    aria-label={labels.aiCollapse}
                    className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-mute hover:bg-ivory hover:text-ink"
                    data-testid="local-editor-ai-close"
                    title={labels.aiCollapse}
                    type="button"
                    onClick={() => setAiOpen(false)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <StudioAiTab
                  canManage={canManage && lockHeldByMe && lockConfirmedByMe}
                  files={draftFiles}
                  focusPath={flowPath}
                  labels={labels.ai}
                  packageId={packageId}
                  sessionId={sessionIdRef.current}
                  onActivity={onAssistantActivity}
                  onBeforeSend={flushBeforeAssistant}
                  onBusyChange={setAssistantBusy}
                  onHeaderInfo={setAiHeader}
                />
              </div>
            </div>
          ) : null}
          <div
            ref={setInspectorEl}
            className={aiOpen ? "hidden" : "flex min-h-0"}
            data-testid="local-editor-inspector-column"
          />
        </aside>
      </div>
    </div>
  );
}

function LockBanner({
  lockHeldByMe,
  holderLabel,
  status,
  labels,
  onReload,
}: {
  lockHeldByMe: boolean;
  holderLabel: string | null;
  status: SaveStatus;
  labels: LocalPackageEditorLabels;
  onReload: () => void;
}): ReactElement | null {
  if (status.kind === "conflict") {
    return (
      <Banner testid="local-editor-conflict" tone="danger">
        <span>{labels.lockLost}</span>
        <button
          className="rounded-md border border-danger-line bg-paper px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-danger hover:bg-danger-soft"
          data-testid="local-editor-reload"
          type="button"
          onClick={onReload}
        >
          {labels.reload}
        </button>
      </Banner>
    );
  }

  if (!lockHeldByMe) {
    return (
      <Banner testid="local-editor-readonly" tone="amber">
        {holderLabel
          ? labels.readOnlyHeld.replace("$holder", holderLabel)
          : labels.readOnlyUnknownHolder}
      </Banner>
    );
  }

  if (status.kind === "saving") {
    return (
      <Banner testid="local-editor-saving" tone="mute">
        {labels.saving}
      </Banner>
    );
  }
  if (status.kind === "saved") {
    return (
      <Banner testid="local-editor-saved" tone="good">
        <span aria-hidden>✓</span> {labels.saved}
      </Banner>
    );
  }
  if (status.kind === "error") {
    return (
      <Banner testid="local-editor-error" tone="danger">
        {labels.saveFailed} — {status.message}
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  testid,
  children,
}: {
  tone: "amber" | "danger" | "good" | "mute";
  testid: string;
  children: ReactNode;
}): ReactElement {
  const toneClass: Record<typeof tone, string> = {
    amber: "border-amber-line bg-amber-soft text-amber",
    danger: "border-danger-line bg-danger-soft text-danger",
    good: "border-line bg-ivory text-good",
    mute: "border-line bg-paper text-mute",
  };

  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2 font-mono text-[11px] ${toneClass[tone]}`}
      data-testid={testid}
      role="status"
    >
      {children}
    </div>
  );
}

// Encode a working-dir-relative path into a `[...path]` catch-all url, segment by
// segment (preserve the `/` separators, escape everything else).
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function peekErrorCode(res: Response): Promise<string | null> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: string } | null;

  return body?.code ?? null;
}
