"use client";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";
import type {
  AttachmentKind,
  ComposerAttachment,
  ScratchDialogStatus,
} from "@/lib/scratch-runs/dialog";
import type { QuickReply } from "@/lib/scratch-runs/transcript";
import type { ReactElement } from "react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { CapabilityComposer } from "@/components/capabilities/capability-composer";
import { canCompose, canRecover, canSend } from "@/lib/scratch-runs/dialog";

const inputBase =
  "min-w-0 max-w-full w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";

type ComposerDraft = {
  content: string;
  attachments: ComposerAttachment[];
  files: File[];
};

export interface ScratchComposerProps {
  status: ScratchDialogStatus;
  pending: boolean;
  quickReplies: QuickReply[];
  agent?: AdapterId;
  catalog?: ProjectCapabilityCatalogEntry[];
  attachmentsEnabled?: boolean;
  recoverEnabled?: boolean;
  // Dock/compact placement (Flow Studio assistant): Send is overlaid bottom-right
  // over the input, with the attachment/busy chips overlaid bottom-left, so the
  // short docked panel keeps maximum room for the transcript.
  compact?: boolean;
  disabledReason?: string | null;
  // Returns true when the message landed (the composer clears its draft);
  // false keeps the draft so the user can retry without retyping.
  onSend: (payload: {
    content: string;
    attachments: ComposerAttachment[];
    files: File[];
  }) => Promise<boolean>;
  onRecover: (prompt: string) => Promise<boolean>;
  // Interrupt the agent's in-flight turn (session/cancel). Returns true when the
  // cancel was accepted. While the agent is busy the Send button becomes Stop;
  // a non-empty draft is auto-sent once the turn ends (back to WaitingForUser).
  onInterrupt?: () => Promise<boolean>;
}

// The scratch message composer (M35 T3.2): capability-aware prompt editor +
// structured attachments + file upload + quick replies, with Send routed to
// /recover for a Crashed run.
// Owns its own draft state and clears only on a successful submit.
export function ScratchComposer({
  status,
  pending,
  quickReplies,
  agent = "claude",
  catalog = [],
  attachmentsEnabled = true,
  recoverEnabled = true,
  compact = false,
  disabledReason = null,
  onSend,
  onRecover,
  onInterrupt,
}: ScratchComposerProps): ReactElement {
  const t = useTranslations("scratch");
  const [content, setContent] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [composerFiles, setComposerFiles] = useState<File[]>([]);
  const [interrupting, setInterrupting] = useState(false);
  const draftRef = useRef<ComposerDraft>({
    content: "",
    attachments: [],
    files: [],
  });
  // Armed by a Stop click (or Cmd/Ctrl+Enter while busy) that had a non-empty
  // draft: the draft auto-sends once the cancelled turn returns to
  // WaitingForUser. See the effect below.
  const [autoSendArmed, setAutoSendArmed] = useState(false);
  const composerFileBytes = useMemo(
    () => composerFiles.reduce((sum, file) => sum + file.size, 0),
    [composerFiles],
  );

  draftRef.current = {
    content,
    attachments: composerAttachments,
    files: composerFiles,
  };

  const clearDraft = useCallback((): ComposerDraft => {
    const draft = draftRef.current;

    draftRef.current = { content: "", attachments: [], files: [] };
    setContent("");
    setComposerAttachments([]);
    setComposerFiles([]);

    return draft;
  }, []);

  const restoreDraftIfUntouched = useCallback((draft: ComposerDraft): void => {
    const current = draftRef.current;

    if (
      current.content.length > 0 ||
      current.attachments.length > 0 ||
      current.files.length > 0
    ) {
      return;
    }

    draftRef.current = draft;
    setContent(draft.content);
    setComposerAttachments(draft.attachments);
    setComposerFiles(draft.files);
  }, []);

  const agentBusy = status === "Running" || status === "Starting";
  const canUseComposer =
    canCompose(status) &&
    disabledReason === null &&
    (recoverEnabled || !canRecover(status));
  // The editor stays editable while the agent is busy so the user can draft the
  // next message (and Stop-then-send it) instead of waiting for the turn.
  const composerEditable =
    disabledReason === null && (canUseComposer || agentBusy);
  const showStop = agentBusy && !!onInterrupt;
  const canSubmitMessage = !!content.trim() && canUseComposer;
  const placeholder = disabledReason
    ? disabledReason
    : canSend(status)
      ? t("messagePlaceholder")
      : agentBusy
        ? t("draftWhileBusy")
        : canRecover(status) && recoverEnabled
          ? t("recoverPlaceholder")
          : t("messageDisabled");

  async function handleStop(): Promise<void> {
    if (!onInterrupt || interrupting) return;
    setInterrupting(true);

    try {
      const ok = await onInterrupt();

      if (ok && content.trim()) setAutoSendArmed(true);
    } finally {
      setInterrupting(false);
    }
  }

  // Auto-send the armed draft once the interrupted turn settles back to a
  // sendable state. Sends directly (the WaitingForUser path is always a plain
  // send, never recover) and clears the draft on success.
  useEffect(() => {
    if (!autoSendArmed || !canSend(status) || pending) return;
    const trimmed = content.trim();

    if (!trimmed) {
      setAutoSendArmed(false);

      return;
    }
    setAutoSendArmed(false);
    void (async () => {
      const draft = clearDraft();
      const sent = await onSend({
        content: trimmed,
        attachments: draft.attachments,
        files: draft.files,
      });

      if (!sent) restoreDraftIfUntouched(draft);
    })();
  }, [
    autoSendArmed,
    status,
    pending,
    content,
    clearDraft,
    onSend,
    restoreDraftIfUntouched,
  ]);

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

  function applyQuickReply(value: string): void {
    setContent(value);
  }

  async function submit(): Promise<void> {
    const trimmed = content.trim();

    if (!trimmed) return;
    if (!canUseComposer) return;

    if (canRecover(status)) {
      const draft = clearDraft();

      if (!(await onRecover(trimmed))) restoreDraftIfUntouched(draft);

      return;
    }

    // Attachment normalization (trim, label-coalesce, drop empties) lives once
    // in the conversation's sendMessage; the composer passes its raw draft.
    const draft = clearDraft();
    const sent = await onSend({
      content: trimmed,
      attachments: draft.attachments,
      files: draft.files,
    });

    if (!sent) restoreDraftIfUntouched(draft);
  }

  const hasClusterContent =
    (attachmentsEnabled && canSend(status)) || agentBusy;
  const attachmentCluster = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {attachmentsEnabled && canSend(status) ? (
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
      ) : null}
      {agentBusy ? (
        <div
          className="flex min-w-0 items-center gap-2 rounded-full border border-amber-line bg-amber-soft px-3 py-1.5 font-mono text-[11px] text-ink-2"
          data-testid="scratch-agent-busy"
        >
          <span
            aria-hidden="true"
            className="h-3 w-3 rounded-full border-2 border-amber/30 border-t-amber motion-safe:animate-spin"
          />
          <span className="truncate">{t("agentBusy")}</span>
        </div>
      ) : null}
    </div>
  );
  const sendButton = (
    <button
      className="rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
      data-testid="scratch-composer-send"
      disabled={!canSubmitMessage || pending}
      type="submit"
    >
      {pending ? t("sending") : canRecover(status) ? t("recover") : t("send")}
    </button>
  );
  const stopButton = (
    <button
      className="inline-flex items-center gap-1.5 rounded-full border border-[#d9534f]/40 bg-[#d9534f]/10 px-4 py-2 text-[13px] font-semibold text-[#d9534f] transition hover:bg-[#d9534f] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      data-testid="scratch-composer-stop"
      disabled={interrupting}
      title={t("interruptTitle")}
      type="button"
      onClick={() => void handleStop()}
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-[2px] bg-current"
      />
      {interrupting ? t("interrupting") : t("interrupt")}
    </button>
  );
  const primaryButton = showStop ? stopButton : sendButton;
  const composer = (
    <CapabilityComposer
      agent={agent}
      ariaLabel={t("composerMessageAria")}
      catalog={catalog}
      className={clsx(
        inputBase,
        compact ? "min-h-[84px] pb-12" : "min-h-[110px]",
      )}
      disabled={!composerEditable}
      labels={{
        placeholder,
        unsupportedBadge: t("composerUnsupported"),
      }}
      testId="scratch-message-composer"
      value={content}
      onChange={setContent}
      onSubmitShortcut={() => {
        if (canSubmitMessage && !pending) {
          void submit();

          return;
        }
        // Cmd/Ctrl+Enter while the agent is busy stops the turn and queues the
        // draft to auto-send once it settles.
        if (showStop && content.trim() && !interrupting) void handleStop();
      }}
    />
  );

  return (
    <form
      className={clsx(
        "min-w-0 max-w-full border-t border-line-soft px-4",
        compact ? "py-2" : "py-3",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {quickReplies.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-1.5">
          {quickReplies.map((reply, index) => (
            <button
              key={`${index}-${reply.value}`}
              className="max-w-full truncate rounded-full border border-amber-line bg-amber-soft px-3 py-1 text-left font-mono text-[11px] text-ink transition hover:border-amber hover:bg-amber hover:text-white"
              type="button"
              onClick={() => applyQuickReply(reply.value)}
            >
              {reply.label}
            </button>
          ))}
        </div>
      ) : null}
      {compact ? (
        <div className="relative min-w-0">
          {composer}
          {hasClusterContent ? (
            <div className="absolute bottom-2.5 left-2.5 z-10 flex min-w-0 max-w-[60%]">
              {attachmentCluster}
            </div>
          ) : null}
          <div className="absolute bottom-2.5 right-2.5 z-10">
            {primaryButton}
          </div>
        </div>
      ) : (
        composer
      )}
      {attachmentsEnabled && composerAttachments.length > 0 ? (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          {composerAttachments.map((attachment, index) => (
            <div
              key={`${attachment.kind}-${index}`}
              className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,120px)_minmax(0,1fr)_minmax(0,1.5fr)_auto]"
            >
              <select
                aria-label={t("composerKindAria")}
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
                aria-label={t("attachmentLabel")}
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
                aria-label={t("attachmentValue")}
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
      {attachmentsEnabled ? (
        <div className="mt-2 min-w-0">
          <input
            multiple
            aria-label={t("composerFilesAria")}
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
      ) : null}
      {!compact ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          {attachmentCluster}
          {primaryButton}
        </div>
      ) : null}
    </form>
  );
}
