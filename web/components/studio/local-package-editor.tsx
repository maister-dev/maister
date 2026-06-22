"use client";

import type { FlowEditorTabsLabels } from "@/components/flows/flow-editor-tabs";
import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { LocalPackageDiffLabels } from "@/components/studio/local-package-diff-drawer";
import type { DiffViewLabels } from "@/components/workbench/diff-view";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { LockState } from "@/lib/local-packages/lock";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement, ReactNode } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { LocalPackageDiffDrawer } from "@/components/studio/local-package-diff-drawer";
import {
  StudioAiTab,
  type StudioAiTabLabels,
} from "@/components/studio/studio-ai-tab";
import {
  buildImportDialogLabels,
  ImportDialog,
} from "@/components/studio/import-dialog";
import { readApiError } from "@/lib/api-error";
import { isMaisterError } from "@/lib/errors-core";
import {
  overlayFlowBuffer,
  parsePackageFilesJson,
  planWorkingDirWrites,
} from "@/lib/local-packages/working-dir-save";

// Client-projected lock state (Date → ISO string for the RSC boundary).
export type LockSnapshot = {
  held: boolean;
  heldByMe: boolean;
  holderLabel: string | null;
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
  // M36 T5.7: Properties ⇆ AI tab toggle + the docked assistant panel.
  tabProperties: string;
  tabAi: string;
  aiWorking: string;
  ai: StudioAiTabLabels;
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
  const [holderLabel, setHolderLabel] = useState(initialLock.holderLabel);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  // Bumped after a successful save or import so the git-diff drawer re-fetches
  // the working-tree diff + its changed-count.
  const [diffRefresh, setDiffRefresh] = useState(0);
  // M36 T5.7: Properties ⇆ AI tab + the "AI working" read-only lock. While the
  // assistant holds a turn the human editor is read-only; control returns on
  // turn end (assistantBusy → false).
  const [activeTab, setActiveTab] = useState<"properties" | "ai">("properties");
  const [assistantBusy, setAssistantBusy] = useState(false);
  // Latches once the AI tab is first opened so its panel (and its single ACP
  // run) stays mounted while the editor is open, even when toggled back to
  // Properties.
  const aiOpenedRef = useRef(false);

  const openTab = useCallback((tab: "properties" | "ai"): void => {
    if (tab === "ai") aiOpenedRef.current = true;
    setActiveTab(tab);
  }, []);

  // On any assistant stream activity, re-read the working dir: the canvas
  // (router.refresh re-runs the server compile) and the git-diff drawer's
  // changed-count (diffRefresh) reflect files the assistant just wrote.
  const onAssistantActivity = useCallback((): void => {
    setDiffRefresh((n) => n + 1);
    router.refresh();
  }, [router]);

  const applyLock = useCallback((lock: LockState | LockSnapshot): void => {
    setLockHeldByMe(lock.heldByMe);
    setHolderLabel(lock.holderLabel ?? null);
  }, []);

  // Acquire on open + keep-alive heartbeat. A failed refresh degrades to
  // read-only rather than throwing — the next write's lock assertion is the
  // hard gate.
  useEffect(() => {
    let cancelled = false;
    const sessionId = sessionIdRef.current;

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

          return;
        }
        applyLock((await res.json()) as LockState);
      } catch {
        if (!cancelled) setLockHeldByMe(false);
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

  // The working-dir save action injected into FlowEditorTabs. It runs inside the
  // editor's own <form>, so it receives the submitted blob; it diffs against the
  // originals and emits the minimal PUT/DELETE set, each lock-guarded server-side.
  const originalRef = useRef(files);

  originalRef.current = files;

  const saveAction = useCallback(
    async (formData: FormData): Promise<void> => {
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

              return;
            }
            setStatus({
              kind: "error",
              message: await readApiError(res, tApiErrors),
            });

            return;
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

            return;
          }
        }

        setStatus({ kind: "saved" });
        setDiffRefresh((n) => n + 1);
        router.refresh();
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            isMaisterError(err) || err instanceof Error
              ? err.message
              : String(err),
        });
      }
    },
    [packageId, flowPath, initialTitle, router, tApiErrors],
  );

  // Editing is blocked when the lock is foreign/lost OR the assistant holds a
  // turn ("AI working"). The assistant writes as the lock holder; the human
  // editor steps back until the turn ends.
  const readOnly = !canManage || !lockHeldByMe || assistantBusy;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div
          className="flex shrink-0 rounded-[10px] border border-line bg-paper p-0.5"
          data-testid="local-editor-tabs"
          role="tablist"
        >
          <TabButton
            active={activeTab === "properties"}
            label={labels.tabProperties}
            testid="local-editor-tab-properties"
            onClick={() => openTab("properties")}
          />
          <TabButton
            active={activeTab === "ai"}
            label={labels.tabAi}
            testid="local-editor-tab-ai"
            onClick={() => openTab("ai")}
          />
        </div>
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
          disabled={readOnly || activeTab !== "properties"}
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

      <div className="min-h-0 flex-1">
        {/* FlowEditorTabs stays MOUNTED across the tab toggle so canvas/YAML
            edit state survives switching to AI and back; only visibility flips. */}
        <div className={activeTab === "properties" ? "h-full" : "hidden"}>
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
              />
            }
            draftVersion={0}
            filesDrawer={
              <PackageFilesEditor
                disabled={readOnly}
                files={files}
                kindLabels={fileKindLabels}
                labels={filesLabels}
                mcpCatalog={mcpCatalog}
              />
            }
            hasDraft={false}
            identity={identity}
            initialManifest={canvasAvailable ? initialManifest : null}
            initialTitle={initialTitle}
            initialYaml={initialYaml}
            labels={labels.editor}
            layout={layout}
            lifecycleLabel={identity.kind}
            projectSlug={identity.slug}
            publishAction={saveAction}
            readinessReady={false}
            saveAction={saveAction}
            topology={topology}
          />
        </div>
        {/* The AI tab mounts on first open and stays mounted (its ACP run lives
            while the editor tab is open); only visibility flips thereafter. */}
        {aiOpenedRef.current ? (
          <div
            className={
              activeTab === "ai"
                ? "h-full overflow-hidden rounded-xl border border-line bg-paper"
                : "hidden"
            }
          >
            <StudioAiTab
              canManage={canManage && lockHeldByMe}
              labels={labels.ai}
              packageId={packageId}
              sessionId={sessionIdRef.current}
              onActivity={onAssistantActivity}
              onBusyChange={setAssistantBusy}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TabButton({
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
      aria-selected={active}
      className={`rounded-[8px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
        active ? "bg-ivory text-ink" : "text-mute hover:text-ink"
      }`}
      data-testid={testid}
      role="tab"
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
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
