"use client";

import type {
  ComposerAttachment,
  ScratchDetail,
  ScratchDialogStatus,
} from "@/lib/scratch-runs/dialog";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";
import type { RunningLiveCommand } from "@/lib/capabilities/running-catalog";
import type { ReactElement } from "react";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  ScratchTranscript,
  type TranscriptLabels,
} from "@/components/scratch/scratch-transcript";
import { ScratchComposer } from "@/components/scratch/scratch-composer";
import { ScratchPermissionPanel } from "@/components/scratch/scratch-permission-panel";
import {
  attachmentSummary,
  canCompose,
  errorText,
} from "@/lib/scratch-runs/dialog";
import { buildRunningCommandCatalog } from "@/lib/capabilities/running-catalog";
import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";
import {
  parseQuickReplies,
  parseScratchMessageContent,
} from "@/lib/scratch-runs/transcript";

const shell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";

function statusClass(status: ScratchDialogStatus): string {
  switch (status) {
    case "WaitingForUser":
      return "border-accent-4 bg-accent-4-soft text-accent-4";
    case "Running":
    case "Starting":
      return "border-amber-line bg-amber-soft text-amber";
    case "NeedsInput":
      return "border-amber bg-amber-soft text-amber";
    case "Review":
    case "Done":
      return "border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft text-accent-4";
    case "Crashed":
      return "border-[#d9534f]/40 bg-[#d9534f]/10 text-[#d9534f]";
    case "Abandoned":
      return "border-line bg-ivory text-mute";
  }
}

// The live conversation center for a scratch run (M35 T3.2/T3.4): owns the
// SSE-triggered detail refresh and the send / recover / HITL handlers, and
// composes the transcript, permission panel, and composer. The former sidebar
// (context, capabilities, diff, promote, lifecycle actions) now lives in the
// shared run inspector + workbench rendered by the scratch layout.
export function ScratchConversation({
  runId,
}: {
  runId: string;
}): ReactElement {
  const t = useTranslations("scratch");
  const [detail, setDetail] = useState<ScratchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [commandCatalog, setCommandCatalog] = useState<
    ProjectCapabilityCatalogEntry[]
  >([]);

  const loadDetail = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/scratch-runs/${runId}`);

      if (!response.ok) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }

      setDetail((await response.json()) as ScratchDetail);
      setDetailRevision((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const composerAgent: AdapterId = useMemo(() => {
    const rawAgent =
      detail?.run.capabilityAgent ??
      detail?.run.runnerSnapshot?.capabilityAgent ??
      "claude";

    return getAdapterSupportById(rawAgent)?.id ?? "claude";
  }, [
    detail?.run.capabilityAgent,
    detail?.run.runnerSnapshot?.capabilityAgent,
  ]);

  useEffect(() => {
    const projectSlug = detail?.run.projectSlug;

    if (!projectSlug) {
      setCommandCatalog([]);

      return;
    }

    const encodedProjectSlug = encodeURIComponent(projectSlug);
    const controller = new AbortController();

    async function loadCommandCatalog(): Promise<void> {
      const [catalogResponse, commandsResponse] = await Promise.all([
        fetch(
          `/api/projects/${encodedProjectSlug}/capability-catalog?agent=${encodeURIComponent(composerAgent)}`,
          { signal: controller.signal },
        ),
        fetch(`/api/scratch-runs/${runId}/commands`, {
          signal: controller.signal,
        }),
      ]);
      const catalogPayload = catalogResponse.ok
        ? ((await catalogResponse.json()) as {
            capabilities?: ProjectCapabilityCatalogEntry[];
          })
        : { capabilities: [] };
      const commandsPayload = commandsResponse.ok
        ? ((await commandsResponse.json()) as {
            commands?: RunningLiveCommand[];
          })
        : { commands: [] };

      setCommandCatalog(
        buildRunningCommandCatalog(
          commandsPayload.commands ?? [],
          catalogPayload.capabilities ?? [],
          composerAgent,
        ),
      );
    }

    void loadCommandCatalog().catch((err) => {
      if (controller.signal.aborted) return;
      setCommandCatalog([]);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => controller.abort();
  }, [composerAgent, detail?.run.projectSlug, detailRevision, runId]);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/stream`);
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadDetail();
      }, 250);
    };

    source.onmessage = scheduleRefresh;

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      source.close();
    };
  }, [loadDetail, runId]);

  const attachmentsByMessage = useMemo(() => {
    const result = new Map<string, ScratchDetail["attachments"]>();

    for (const attachment of detail?.attachments ?? []) {
      if (!attachment.messageId) continue;
      const list = result.get(attachment.messageId) ?? [];

      list.push(attachment);
      result.set(attachment.messageId, list);
    }

    return result;
  }, [detail?.attachments]);
  const globalAttachments =
    detail?.attachments.filter((attachment) => !attachment.messageId) ?? [];
  const status = detail?.scratch.dialogStatus ?? "Starting";
  const latestUsage = useMemo(() => {
    let usage: { used: number; size: number } | null = null;

    for (const message of detail?.messages ?? []) {
      const parsed = parseScratchMessageContent(message.role, message.content);

      if (parsed.kind === "usage") {
        usage = { used: parsed.used, size: parsed.size };
      }
    }

    return usage;
  }, [detail?.messages]);
  const transcriptLabels: TranscriptLabels = {
    thinking: t("thinking"),
    rawEvent: t("rawEvent"),
    input: t("toolInput"),
    result: t("toolResult"),
    copy: t("copy"),
    copied: t("copied"),
    toolCount: (name, count) => t("toolCount", { name, count }),
  };
  const quickReplies = useMemo(() => {
    if (!canCompose(status)) return [];
    const messages = detail?.messages ?? [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];

      if (candidate.role === "assistant") {
        return parseQuickReplies(candidate.content);
      }
    }

    return [];
  }, [detail?.messages, status]);
  const renderMessageAttachments = useCallback(
    (messageId: string) => {
      const list = attachmentsByMessage.get(messageId) ?? [];

      if (list.length === 0) return null;

      return (
        <ul className="mt-2 flex list-none flex-col gap-1 p-0">
          {list.map((attachment) => (
            <li
              key={attachment.id}
              className="rounded-md border border-line bg-paper/70 px-2 py-1 font-mono text-[10.5px] text-mute"
            >
              {attachment.kind}: {attachmentSummary(attachment)}
            </li>
          ))}
        </ul>
      );
    },
    [attachmentsByMessage],
  );

  const sendMessage = useCallback(
    async (payload: {
      content: string;
      attachments: ComposerAttachment[];
      files: File[];
    }): Promise<boolean> => {
      setPendingAction("send");
      setError(null);

      const attachments = payload.attachments
        .map((attachment) => ({
          kind: attachment.kind,
          label: attachment.label.trim() || undefined,
          value: attachment.value.trim(),
        }))
        .filter((attachment) => attachment.value.length > 0);

      try {
        const body = { content: payload.content, attachments };
        const requestInit: RequestInit =
          payload.files.length > 0
            ? (() => {
                const formData = new FormData();

                formData.set("payload", JSON.stringify(body));
                for (const file of payload.files)
                  formData.append("files", file);

                return { method: "POST", body: formData };
              })()
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              };
        const response = await fetch(
          `/api/scratch-runs/${runId}/messages`,
          requestInit,
        );

        if (!response.ok) {
          setError(errorText(await response.json().catch(() => null)));

          return false;
        }

        await loadDetail();

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));

        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [loadDetail, runId],
  );

  const recover = useCallback(
    async (prompt: string): Promise<boolean> => {
      setPendingAction("send");
      setError(null);

      try {
        const response = await fetch(`/api/scratch-runs/${runId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
          setError(errorText(await response.json().catch(() => null)));

          return false;
        }

        await loadDetail();

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));

        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [loadDetail, runId],
  );

  const answerHitl = useCallback(
    async (payload: Record<string, unknown>): Promise<void> => {
      if (!detail?.pendingHitl) return;
      setPendingAction("hitl");
      setError(null);

      try {
        const response = await fetch(
          `/api/runs/${runId}/hitl/${detail.pendingHitl.hitlRequestId}/respond`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );

        if (!response.ok) {
          setError(errorText(await response.json().catch(() => null)));

          return;
        }

        await loadDetail();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingAction(null);
      }
    },
    [detail?.pendingHitl, loadDetail, runId],
  );

  if (loading && !detail) {
    return (
      <div className={`${shell} px-4 py-5 font-mono text-[12px] text-mute`}>
        {t("loadingRun")}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="rounded-lg border border-[#d9534f]/40 bg-[#d9534f]/10 px-3 py-2 text-[12px] leading-[1.5] text-[#d9534f]">
        {error ?? t("runUnavailable")}
      </div>
    );
  }

  return (
    <section
      className={`${shell} flex min-h-[620px] flex-col`}
      data-testid="scratch-conversation"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <span
          className={clsx(
            "rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-semibold",
            statusClass(status),
          )}
          data-testid="scratch-conversation-status"
        >
          {t(`status.${status}`)}
        </span>
        {latestUsage ? (
          <div
            className="flex items-center gap-1.5 font-mono text-[9.5px] text-mute"
            title={t("tokens")}
          >
            <span className="h-1 w-20 overflow-hidden rounded-full bg-ivory">
              <span
                className="block h-full bg-amber"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(
                      (latestUsage.used / Math.max(1, latestUsage.size)) * 100,
                    ),
                  )}%`,
                }}
              />
            </span>
            <span>
              {latestUsage.used.toLocaleString()} /{" "}
              {latestUsage.size.toLocaleString()}
            </span>
          </div>
        ) : null}
      </header>

      {globalAttachments.length > 0 ? (
        <ul className="flex list-none flex-wrap gap-1 border-b border-line-soft px-4 py-2 p-0">
          {globalAttachments.map((attachment) => (
            <li
              key={attachment.id}
              className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-[10.5px] text-mute"
            >
              {attachment.kind}: {attachmentSummary(attachment)}
            </li>
          ))}
        </ul>
      ) : null}

      {detail.messages.length === 0 ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <p className="text-[13px] text-mute">{t("noMessages")}</p>
        </div>
      ) : (
        <ScratchTranscript
          labels={transcriptLabels}
          messages={detail.messages}
          renderAttachments={renderMessageAttachments}
          running={status === "Running" || status === "Starting"}
          userLabel={detail.run.createdByDisplayName}
        />
      )}

      {detail.pendingHitl ? (
        <div className="border-t border-line-soft px-4 py-3">
          <ScratchPermissionPanel
            pending={pendingAction === "hitl"}
            pendingHitl={detail.pendingHitl}
            onAnswer={(payload) => void answerHitl(payload)}
          />
        </div>
      ) : null}

      {status === "Crashed" ? (
        <div className="border-t border-line-soft px-4 py-2 text-[12px] leading-[1.5] text-ink-2">
          {t("recoverHint")}
        </div>
      ) : null}

      {error ? (
        <div className="mx-4 mt-3 rounded-lg border border-[#d9534f]/40 bg-[#d9534f]/10 px-3 py-2 text-[12px] leading-[1.5] text-[#d9534f]">
          {error}
        </div>
      ) : null}

      <ScratchComposer
        agent={composerAgent}
        catalog={commandCatalog}
        pending={pendingAction === "send"}
        quickReplies={quickReplies}
        status={status}
        onRecover={recover}
        onSend={sendMessage}
      />
    </section>
  );
}
