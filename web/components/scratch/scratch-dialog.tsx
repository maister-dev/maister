"use client";

import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { ReactElement } from "react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  ScratchTranscript,
  type TranscriptLabels,
} from "@/components/scratch/scratch-transcript";
import {
  parseQuickReplies,
  parseScratchMessageContent,
} from "@/lib/scratch-runs/transcript";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";
import {
  deriveWorkbenchLifecycleActions,
  type WorkbenchRunStatus,
} from "@/lib/workbench-lifecycle/policy";

type ScratchDialogStatus =
  | "Starting"
  | "WaitingForUser"
  | "Running"
  | "NeedsInput"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned";

type AttachmentKind = "issue_url" | "file_path" | "text_note";
type StoredAttachmentKind = AttachmentKind | "uploaded_file";

type ScratchMessage = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
};

type ScratchAttachment = {
  id: string;
  runId: string;
  messageId: string | null;
  kind: StoredAttachmentKind;
  label: string | null;
  value: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  artifactRef: string | null;
};

type HitlOption = {
  optionId: string;
  label: string;
};

type ScratchDetail = {
  run: {
    id: string;
    status: WorkbenchRunStatus;
    currentStepId: string | null;
    startedAt: string;
    endedAt: string | null;
    createdByDisplayName: string | null;
  };
  scratch: {
    name: string | null;
    workMode: "auto" | "plan_first" | "manual_approval";
    reasoningEffort: "low" | "high" | "extra" | "ultra";
    planMode: "off" | "plan-first";
    linkedIssueUrl: string | null;
    baseBranch: string;
    baseCommit: string;
    targetBranch: string | null;
    dialogStatus: ScratchDialogStatus;
    errorCode: string | null;
    errorMessage: string | null;
  };
  workspace: {
    id?: string;
    branch: string;
    removedAt: string | null;
  } | null;
  messages: ScratchMessage[];
  attachments: ScratchAttachment[];
  pendingHitl: {
    hitlRequestId: string;
    kind: "permission" | "form" | "human";
    prompt: string;
    schema: unknown;
    options: HitlOption[];
  } | null;
  capabilityProfile: {
    selectedMcpIds: string[];
    selectedSkillIds: string[];
    selectedRuleIds: string[];
    restrictions: Record<string, unknown>;
    downgradeNotes: Record<string, unknown> | null;
  } | null;
};

type ComposerAttachment = {
  kind: AttachmentKind;
  label: string;
  value: string;
};

type ApiError = {
  code?: string;
  message?: string;
};

const shell =
  "rounded-lg border border-line-soft bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";
const inputBase =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";

function errorText(payload: ApiError | null): string {
  if (!payload) return "Request failed.";
  if (payload.message) return payload.message;
  if (payload.code) return payload.code;

  return "Request failed.";
}

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

function canSend(status: ScratchDialogStatus): boolean {
  return status === "WaitingForUser";
}

// A crashed run can be resumed by typing a message (routes Send to /recover,
// which respawns + resumes via session/resume). Attachments/files stay message-only.
function canRecover(status: ScratchDialogStatus): boolean {
  return status === "Crashed";
}

function canCompose(status: ScratchDialogStatus): boolean {
  return canSend(status) || canRecover(status);
}

function lifecycleActionsForScratchDetail(
  detail: ScratchDetail,
): WorkbenchLifecycleActionId[] {
  return deriveWorkbenchLifecycleActions({
    runKind: "scratch",
    runStatus: detail.run.status,
    scratchDialogStatus: detail.scratch.dialogStatus,
    hasWorkspace: detail.workspace !== null,
    workspaceRemoved: detail.workspace?.removedAt !== null,
    workspaceArchived: false,
  })
    .filter((action) => action.enabled)
    .map((action) => action.id);
}

function attachmentSummary(attachment: ScratchAttachment): string {
  if (attachment.kind === "uploaded_file") {
    const hash = attachment.sha256 ? attachment.sha256.slice(0, 10) : "";

    return `${attachment.fileName ?? attachment.label ?? "file"} · ${
      attachment.mimeType ?? "application/octet-stream"
    } · ${attachment.byteSize ?? 0} bytes${hash ? ` · ${hash}` : ""}`;
  }

  return attachment.label
    ? `${attachment.label}: ${attachment.value}`
    : attachment.value;
}

export function ScratchDialog({ runId }: { runId: string }): ReactElement {
  const t = useTranslations("scratch");
  const [detail, setDetail] = useState<ScratchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [hitlJson, setHitlJson] = useState("{}");
  const [diff, setDiff] = useState<string | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [composerFiles, setComposerFiles] = useState<File[]>([]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

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
    const result = new Map<string, ScratchAttachment[]>();

    for (const attachment of detail?.attachments ?? []) {
      if (!attachment.messageId) continue;
      const list = result.get(attachment.messageId) ?? [];

      list.push(attachment);
      result.set(attachment.messageId, list);
    }

    return result;
  }, [detail?.attachments]);
  const composerFileBytes = useMemo(
    () => composerFiles.reduce((sum, file) => sum + file.size, 0),
    [composerFiles],
  );
  const globalAttachments =
    detail?.attachments.filter((attachment) => !attachment.messageId) ?? [];
  const status = detail?.scratch.dialogStatus ?? "Starting";
  const lifecycleActions = detail ? lifecycleActionsForScratchDetail(detail) : [];
  const canSubmitMessage = !!content.trim() && canCompose(status);
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
  const applyQuickReply = useCallback((value: string) => {
    setContent(value);
    composerRef.current?.focus();
  }, []);
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

  function updateComposerAttachment(
    index: number,
    patch: Partial<ComposerAttachment>,
  ): void {
    setComposerAttachments((current) =>
      current.map((attachment, itemIndex) =>
        itemIndex === index ? { ...attachment, ...patch } : attachment,
      ),
    );
  }

  async function postAction(
    label: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    setPendingAction(label);
    setError(null);

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });

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
  }

  async function sendMessage(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();

    if (canRecover(status)) {
      const prompt = content.trim();

      if (!prompt) return;
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

          return;
        }
        setContent("");
        await loadDetail();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingAction(null);
      }

      return;
    }

    setPendingAction("send");
    setError(null);

    const attachments = composerAttachments
      .map((attachment) => ({
        kind: attachment.kind,
        label: attachment.label.trim() || undefined,
        value: attachment.value.trim(),
      }))
      .filter((attachment) => attachment.value.length > 0);

    try {
      const payload = { content: content.trim(), attachments };
      const requestInit: RequestInit =
        composerFiles.length > 0
          ? (() => {
              const formData = new FormData();

              formData.set("payload", JSON.stringify(payload));
              for (const file of composerFiles) formData.append("files", file);

              return { method: "POST", body: formData };
            })()
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            };
      const response = await fetch(
        `/api/scratch-runs/${runId}/messages`,
        requestInit,
      );

      if (!response.ok) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }

      setContent("");
      setComposerAttachments([]);
      setComposerFiles([]);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  }

  async function loadDiff(): Promise<void> {
    setPendingAction("diff");
    setError(null);

    try {
      const response = await fetch(`/api/runs/${runId}/diff`);

      if (!response.ok) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }

      const payload = (await response.json()) as { diff: string };

      setDiff(payload.diff || t("emptyDiff"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  }

  async function answerHitl(payload: Record<string, unknown>): Promise<void> {
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
  }

  function submitHitlJson(): void {
    try {
      void answerHitl({ response: JSON.parse(hitlJson) });
    } catch {
      setError(t("invalidJson"));
    }
  }

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
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className={`${shell} flex min-h-[620px] flex-col`}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h1 className="m-0 truncate text-[22px] font-semibold leading-[1.15] tracking-[-0.018em] text-ink">
              {detail.scratch.name ?? detail.workspace?.branch ?? runId}
            </h1>
            <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10.5px] text-mute">
              <span>{detail.workspace?.branch ?? t("noWorkspace")}</span>
              <span>·</span>
              <span>{detail.scratch.baseBranch}</span>
              <span>·</span>
              <span>{detail.scratch.workMode}</span>
              <span>·</span>
              <span>{detail.scratch.reasoningEffort}</span>
            </div>
          </div>
          <div className="flex flex-none flex-col items-end gap-1.5">
            <span
              className={clsx(
                "rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-semibold",
                statusClass(status),
              )}
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
                          (latestUsage.used / Math.max(1, latestUsage.size)) *
                            100,
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
          </div>
        </header>

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

        <form
          className="border-t border-line-soft px-4 py-3"
          onSubmit={sendMessage}
        >
          {quickReplies.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {quickReplies.map((reply, index) => (
                <button
                  key={`${index}-${reply.value}`}
                  className="rounded-full border border-amber-line bg-amber-soft px-3 py-1 text-left font-mono text-[11px] text-ink transition hover:border-amber hover:bg-amber hover:text-white"
                  type="button"
                  onClick={() => applyQuickReply(reply.value)}
                >
                  {reply.label}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            className={clsx(inputBase, "min-h-[110px] resize-y")}
            disabled={!canCompose(status)}
            placeholder={
              canSend(status)
                ? t("messagePlaceholder")
                : canRecover(status)
                  ? t("recoverPlaceholder")
                  : t("messageDisabled")
            }
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          {composerAttachments.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {composerAttachments.map((attachment, index) => (
                <div
                  key={`${attachment.kind}-${index}`}
                  className="grid gap-2 md:grid-cols-[120px_1fr_1.5fr_auto]"
                >
                  <select
                    className={inputBase}
                    value={attachment.kind}
                    onChange={(event) =>
                      updateComposerAttachment(index, {
                        kind: event.target.value as AttachmentKind,
                      })
                    }
                  >
                    <option value="issue_url">
                      {t("attachmentKind.issue_url")}
                    </option>
                    <option value="file_path">
                      {t("attachmentKind.file_path")}
                    </option>
                    <option value="text_note">
                      {t("attachmentKind.text_note")}
                    </option>
                  </select>
                  <input
                    className={inputBase}
                    placeholder={t("attachmentLabel")}
                    value={attachment.label}
                    onChange={(event) =>
                      updateComposerAttachment(index, {
                        label: event.target.value,
                      })
                    }
                  />
                  <input
                    className={inputBase}
                    placeholder={t("attachmentValue")}
                    value={attachment.value}
                    onChange={(event) =>
                      updateComposerAttachment(index, {
                        value: event.target.value,
                      })
                    }
                  />
                  <button
                    className="rounded-lg border border-line px-3 font-mono text-[11px] text-mute hover:border-amber hover:text-amber"
                    type="button"
                    onClick={() =>
                      setComposerAttachments((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-2">
            <input
              multiple
              className={inputBase}
              disabled={!canSend(status)}
              type="file"
              onChange={(event) =>
                setComposerFiles(Array.from(event.currentTarget.files ?? []))
              }
            />
            {composerFiles.length > 0 ? (
              <div className="mt-1 font-mono text-[10.5px] text-mute">
                {t("fileSummary", {
                  count: composerFiles.length,
                  bytes: composerFileBytes,
                })}
              </div>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {canSend(status) ? (
              <button
                className="rounded-full border border-line bg-paper px-3 py-1.5 font-mono text-[11px] text-ink-2 hover:border-amber hover:text-amber"
                type="button"
                onClick={() =>
                  setComposerAttachments((current) => [
                    ...current,
                    { kind: "text_note", label: "", value: "" },
                  ])
                }
              >
                + {t("attachment")}
              </button>
            ) : (
              <span />
            )}
            <button
              className="rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canSubmitMessage || pendingAction === "send"}
              type="submit"
            >
              {pendingAction === "send"
                ? t("sending")
                : canRecover(status)
                  ? t("recover")
                  : t("send")}
            </button>
          </div>
        </form>
      </section>

      <aside className="flex flex-col gap-4">
        {detail.pendingHitl ? (
          <section
            className={`${shell} border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-3`}
          >
            <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber">
              {t("permission")}
            </div>
            <p className="mb-3 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
              {detail.pendingHitl.prompt}
            </p>
            {detail.pendingHitl.kind === "permission" ? (
              <div className="flex flex-wrap gap-2">
                {detail.pendingHitl.options.map((option) => (
                  <button
                    key={option.optionId}
                    className={clsx(
                      "rounded-lg border px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                      option.optionId.includes("deny")
                        ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                        : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                    )}
                    disabled={pendingAction === "hitl"}
                    type="button"
                    onClick={() =>
                      void answerHitl({ optionId: option.optionId })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <textarea
                  className={clsx(inputBase, "min-h-[120px]")}
                  value={hitlJson}
                  onChange={(event) => setHitlJson(event.target.value)}
                />
                <button
                  className="w-max rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:opacity-60"
                  disabled={pendingAction === "hitl"}
                  type="button"
                  onClick={submitHitlJson}
                >
                  {t("submit")}
                </button>
              </div>
            )}
          </section>
        ) : null}

        <section className={`${shell} p-3`}>
          <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("actions")}
          </div>
          <div className="flex flex-col gap-2">
            {lifecycleActions.length > 0 ? (
              <WorkbenchLifecycleActions
                actions={lifecycleActions}
                className="rounded-lg border border-line bg-paper p-2"
                runId={runId}
                runKind="scratch"
                variant="detail"
              />
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <button
                className="rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-semibold text-ink-2 hover:border-amber hover:text-amber"
                type="button"
                onClick={() => void loadDiff()}
              >
                {t("diff")}
              </button>
              <button
                className="rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-semibold text-ink-2 hover:border-amber hover:text-amber"
                type="button"
                onClick={() =>
                  void postAction("promote", `/api/runs/${runId}/promote`, {
                    mode: "local_merge",
                    targetBranch: detail.scratch.baseBranch,
                  })
                }
              >
                {t("promote")}
              </button>
            </div>
          </div>
          {pendingAction && pendingAction !== "send" ? (
            <p className="mt-2 font-mono text-[10.5px] text-mute">
              {t("pendingAction", { action: pendingAction })}
            </p>
          ) : null}
        </section>

        {status === "Crashed" ? (
          <section
            className={`${shell} border-[#d9534f]/30 bg-[#d9534f]/5 p-3`}
          >
            <div className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#d9534f]">
              {t("recover")}
            </div>
            <p className="text-[12px] leading-[1.5] text-ink-2">
              {t("recoverHint")}
            </p>
          </section>
        ) : null}

        <section className={`${shell} p-3`}>
          <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("context")}
          </div>
          <dl className="grid gap-2 text-[12px]">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                {t("worktree")}
              </dt>
              <dd className="break-all text-ink-2">
                {detail.workspace?.branch ?? t("noWorkspace")}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                {t("baseCommit")}
              </dt>
              <dd className="break-all font-mono text-[11px] text-ink-2">
                {detail.scratch.baseCommit}
              </dd>
            </div>
            {detail.scratch.linkedIssueUrl ? (
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {t("linkedIssue")}
                </dt>
                <dd className="break-all text-ink-2">
                  {detail.scratch.linkedIssueUrl}
                </dd>
              </div>
            ) : null}
          </dl>
          {globalAttachments.length > 0 ? (
            <ul className="mt-3 flex list-none flex-col gap-1 p-0">
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
        </section>

        <section className={`${shell} p-3`}>
          <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("capabilities")}
          </div>
          <div className="flex flex-wrap gap-1.5 font-mono text-[10.5px] text-ink-2">
            <span className="rounded-full border border-line bg-paper px-2 py-1">
              {t("mcps")} {detail.capabilityProfile?.selectedMcpIds.length ?? 0}
            </span>
            <span className="rounded-full border border-line bg-paper px-2 py-1">
              {t("skills")}{" "}
              {detail.capabilityProfile?.selectedSkillIds.length ?? 0}
            </span>
            <span className="rounded-full border border-line bg-paper px-2 py-1">
              {t("rules")}{" "}
              {detail.capabilityProfile?.selectedRuleIds.length ?? 0}
            </span>
          </div>
        </section>

        {error ? (
          <div className="rounded-lg border border-[#d9534f]/40 bg-[#d9534f]/10 px-3 py-2 text-[12px] leading-[1.5] text-[#d9534f]">
            {error}
          </div>
        ) : null}
      </aside>

      {diff !== null ? (
        <section className={`${shell} xl:col-span-2`}>
          <header className="flex items-center justify-between border-b border-line-soft px-4 py-3">
            <h2 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("diff")}
            </h2>
            <button
              className="font-mono text-[11px] text-mute hover:text-ink"
              type="button"
              onClick={() => setDiff(null)}
            >
              {t("close")}
            </button>
          </header>
          <pre className="max-h-[520px] overflow-auto p-4 font-mono text-[11px] leading-[1.45] text-ink-2">
            {diff}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
