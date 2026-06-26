"use client";

import type { ReactElement } from "react";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { ScratchFlowActionResultPayload } from "@/lib/scratch-runs/transcript";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { CapabilityComposer } from "@/components/capabilities/capability-composer";
import {
  ScratchConversation,
  type ScratchHeaderInfo,
} from "@/components/scratch/scratch-conversation";
import {
  FlowAssistantActionResult,
  type FlowAssistantActionResultLabels,
} from "@/components/studio/flow-assistant-action-result";
import { readApiError } from "@/lib/api-error";
import { buildPackageCapabilityCatalog } from "@/lib/capabilities/package-catalog";
import { useRunStream } from "@/lib/use-run-stream";

export type StudioAiTabLabels = {
  intro: string;
  promptPlaceholder: string;
  launch: string;
  launching: string;
  lockRequired: string;
  runner: string;
  loadingRunners: string;
  noRunners: string;
  saveCurrentChanges: string;
  actionResult: FlowAssistantActionResultLabels;
};

type RunnerOption = {
  id: string;
  label: string;
  adapter: string;
  model: string | null;
  isDefault: boolean;
};

// M36 Phase 5 (ADR-097) T5.7: the bottom AI authoring assistant panel. ONE ACP
// run per editor tab — the run id is held in this component's state for the
// editor mount's lifetime, so editor refreshes never relaunch it. A 2nd browser
// tab generates a fresh lock session that does NOT hold the working-dir lock, so
// its launch is refused server-side (assertHoldsLock) — no 2nd assistant for the
// same holder. Reuses
// ScratchConversation for the transcript + inline HITL + SSE, and the run's
// live stream to drive: (a) the editor "AI working" read-only while a turn is in
// flight, and (b) the diff/canvas refresh after assistant writes.
export function StudioAiTab({
  packageId,
  sessionId,
  canManage,
  labels,
  focusPath,
  files,
  hasUnsavedChanges,
  onBusyChange,
  onActivity,
  onHeaderInfo,
}: {
  packageId: string;
  sessionId: string;
  canManage: boolean;
  labels: StudioAiTabLabels;
  focusPath?: string | null;
  // The live package files — the source for the first-prompt `/`-autosuggest
  // capability catalog (skills derived client-side; the editor is project-less).
  files: AuthoredFlowPackageFile[];
  hasUnsavedChanges: boolean;
  // Lift "assistant turn in flight" so the editor goes read-only ("AI working").
  onBusyChange: (busy: boolean) => void;
  // Bumped on every assistant stream event so the editor re-reads the working
  // dir (canvas + the git-diff drawer's changed-count) — reuses diffRefresh.
  onActivity: () => void;
  // Lifts the run status + token-budget meter to the host's collapsible panel
  // header (null when no run is active).
  onHeaderInfo?: (info: ScratchHeaderInfo | null) => void;
}): ReactElement {
  const t = useTranslations("apiErrors");
  const tScratch = useTranslations("scratch");
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runners, setRunners] = useState<RunnerOption[]>([]);
  const [selectedRunnerId, setSelectedRunnerId] = useState<string>("");
  const [loadingRunners, setLoadingRunners] = useState(true);

  // Change-tick only (retain:false): the run's SSE stream signals assistant
  // activity. We re-read dialogStatus on each tick to drive busy/refresh.
  const { eventCount } = useRunStream(runId, { retain: false });
  const adapter = useMemo<AdapterId>(
    () =>
      (runners.find((runner) => runner.id === selectedRunnerId)?.adapter ??
        "claude") as AdapterId,
    [runners, selectedRunnerId],
  );
  const promptCatalog = useMemo(
    () => buildPackageCapabilityCatalog(files, adapter),
    [files, adapter],
  );
  const sendDisabledReason = !canManage
    ? labels.lockRequired
    : hasUnsavedChanges
      ? labels.saveCurrentChanges
      : null;
  const focus = useMemo(
    () => (focusPath ? { path: focusPath } : {}),
    [focusPath],
  );
  const messageBodyExtras = useMemo(
    () => ({
      sessionId,
      intent: "auto",
      focus,
    }),
    [focus, sessionId],
  );

  const ensureLockHeld = useCallback(async (): Promise<boolean> => {
    const res = await fetch(
      `/api/studio/local-packages/${packageId}/lock-refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, mode: "acquire" }),
      },
    );

    if (!res.ok) {
      setError(await readApiError(res, t));

      return false;
    }

    const lock = (await res.json()) as { heldByMe?: boolean };

    if (lock.heldByMe !== true) {
      setError(labels.lockRequired);

      return false;
    }

    return true;
  }, [labels.lockRequired, packageId, sessionId, t]);

  useEffect(() => {
    let cancelled = false;

    async function loadRunners(): Promise<void> {
      setLoadingRunners(true);

      try {
        const res = await fetch(
          `/api/studio/local-packages/${packageId}/assistant/runners`,
        );

        if (!res.ok) {
          setError(await readApiError(res, t));

          return;
        }

        const body = (await res.json()) as {
          runners: RunnerOption[];
          defaultRunnerId: string | null;
        };

        if (cancelled) return;
        setRunners(body.runners);
        setSelectedRunnerId(
          body.defaultRunnerId &&
            body.runners.some((runner) => runner.id === body.defaultRunnerId)
            ? body.defaultRunnerId
            : (body.runners[0]?.id ?? ""),
        );
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingRunners(false);
      }
    }

    void loadRunners();

    return () => {
      cancelled = true;
    };
  }, [packageId, t]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!runId) return;

    try {
      const res = await fetch(`/api/scratch-runs/${runId}`);

      if (!res.ok) return;
      const detail = (await res.json()) as {
        scratch?: { dialogStatus?: string };
      };
      const status = detail.scratch?.dialogStatus;

      onBusyChange(status === "Running" || status === "Starting");
    } catch {
      /* a transient read failure leaves the last-known busy state */
    }
  }, [runId, onBusyChange]);

  // On each assistant stream event: bump the editor refresh (writes may have
  // landed) and re-read the run's busy state. A new run also kicks one refresh.
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (!runId) return;
    if (eventCount === lastTickRef.current) return;
    lastTickRef.current = eventCount;
    onActivity();
    void refreshStatus();
  }, [eventCount, runId, onActivity, refreshStatus]);

  // Turn end (run gone / tab closed) must not strand the editor read-only.
  useEffect(() => {
    if (!runId) onBusyChange(false);
  }, [runId, onBusyChange]);

  // No run → clear the host panel-header status/usage summary.
  useEffect(() => {
    if (!runId) onHeaderInfo?.(null);
  }, [runId, onHeaderInfo]);

  const launch = useCallback(async (): Promise<void> => {
    const trimmed = prompt.trim();

    if (
      trimmed.length === 0 ||
      launching ||
      sendDisabledReason !== null ||
      selectedRunnerId.length === 0
    ) {
      return;
    }
    setLaunching(true);
    setError(null);

    try {
      if (!(await ensureLockHeld())) return;

      const res = await fetch(
        `/api/studio/local-packages/${packageId}/assistant`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            prompt: trimmed,
            runnerId: selectedRunnerId,
            intent: "auto",
            focus,
          }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, t));

        return;
      }

      const body = (await res.json()) as { runId: string };

      setRunId(body.runId);
      onActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [
    prompt,
    launching,
    sendDisabledReason,
    selectedRunnerId,
    packageId,
    sessionId,
    focus,
    t,
    onActivity,
    ensureLockHeld,
  ]);

  const renderFlowActionResult = useCallback(
    (payload: ScratchFlowActionResultPayload): ReactElement => (
      <FlowAssistantActionResult
        labels={labels.actionResult}
        payload={payload}
      />
    ),
    [labels.actionResult],
  );
  const launchDisabled =
    sendDisabledReason !== null ||
    launching ||
    loadingRunners ||
    selectedRunnerId.length === 0 ||
    prompt.trim().length === 0;

  if (runId) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="studio-ai-tab">
        <ScratchConversation
          compact
          attachmentsEnabled={false}
          messageBodyExtras={messageBodyExtras}
          messageEndpoint={`/api/studio/local-packages/${packageId}/assistant/${runId}/messages`}
          recoverEndpoint={null}
          renderFlowActionResult={renderFlowActionResult}
          runId={runId}
          sendDisabledReason={sendDisabledReason}
          onHeaderInfo={onHeaderInfo}
          onMessageSettled={onActivity}
        />
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 p-4"
      data-testid="studio-ai-tab"
    >
      <p className="text-[13px] leading-[1.55] text-ink-2">{labels.intro}</p>
      {!canManage ? (
        <p
          className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-amber"
          data-testid="studio-ai-lock-required"
          role="status"
        >
          {labels.lockRequired}
        </p>
      ) : null}
      {hasUnsavedChanges && canManage ? (
        <p
          className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-amber"
          data-testid="studio-ai-unsaved"
          role="status"
        >
          {labels.saveCurrentChanges}
        </p>
      ) : null}
      <label className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {labels.runner}
        </span>
        <select
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-50"
          data-testid="studio-ai-runner"
          disabled={
            !canManage || launching || loadingRunners || runners.length === 0
          }
          value={selectedRunnerId}
          onChange={(event) => setSelectedRunnerId(event.target.value)}
        >
          {runners.map((runner) => (
            <option key={runner.id} value={runner.id}>
              {runner.label}
            </option>
          ))}
        </select>
      </label>
      {loadingRunners || runners.length === 0 ? (
        <p
          className="font-mono text-[11px] text-mute"
          data-testid="studio-ai-runner-status"
        >
          {loadingRunners ? labels.loadingRunners : labels.noRunners}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <CapabilityComposer
          agent={adapter}
          ariaLabel={labels.promptPlaceholder}
          catalog={promptCatalog}
          className="h-full w-full overflow-y-auto rounded-lg border border-line bg-paper px-3.5 py-3 pb-14 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute disabled:opacity-50"
          disabled={!canManage || launching || hasUnsavedChanges}
          labels={{
            placeholder: labels.promptPlaceholder,
            unsupportedBadge: tScratch("composerUnsupported"),
          }}
          testId="studio-ai-prompt"
          value={prompt}
          onChange={setPrompt}
          onSubmitShortcut={() => {
            if (!launchDisabled) void launch();
          }}
        />
        <button
          className="absolute bottom-2.5 right-2.5 rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white shadow-[var(--shadow-lg)] transition hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="studio-ai-launch"
          disabled={launchDisabled}
          type="button"
          onClick={() => void launch()}
        >
          {launching ? labels.launching : labels.launch}
        </button>
      </div>
      {error ? (
        <p
          className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
          data-testid="studio-ai-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
