"use client";

import type { QuickReply } from "@/lib/scratch-runs/transcript";
import type {
  AttachmentKind,
  ComposerAttachment,
  ScratchDialogStatus,
} from "@/lib/scratch-runs/dialog";
import type { ReactElement } from "react";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { canCompose, canRecover, canSend } from "@/lib/scratch-runs/dialog";

const inputBase =
  "w-full rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute";

export interface ScratchComposerProps {
  status: ScratchDialogStatus;
  pending: boolean;
  quickReplies: QuickReply[];
  // Returns true when the message landed (the composer clears its draft);
  // false keeps the draft so the user can retry without retyping.
  onSend: (payload: {
    content: string;
    attachments: ComposerAttachment[];
    files: File[];
  }) => Promise<boolean>;
  onRecover: (prompt: string) => Promise<boolean>;
}

// The scratch message composer (M35 T3.2): textarea + structured attachments +
// file upload + quick replies, with Send routed to /recover for a Crashed run.
// Owns its own draft state and clears only on a successful submit.
export function ScratchComposer({
  status,
  pending,
  quickReplies,
  onSend,
  onRecover,
}: ScratchComposerProps): ReactElement {
  const t = useTranslations("scratch");
  const [content, setContent] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [composerFiles, setComposerFiles] = useState<File[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerFileBytes = useMemo(
    () => composerFiles.reduce((sum, file) => sum + file.size, 0),
    [composerFiles],
  );
  const canSubmitMessage = !!content.trim() && canCompose(status);

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
    composerRef.current?.focus();
  }

  async function submit(): Promise<void> {
    const trimmed = content.trim();

    if (!trimmed) return;

    if (canRecover(status)) {
      if (await onRecover(trimmed)) setContent("");

      return;
    }

    // Attachment normalization (trim, label-coalesce, drop empties) lives once
    // in the conversation's sendMessage; the composer passes its raw draft.
    const sent = await onSend({
      content: trimmed,
      attachments: composerAttachments,
      files: composerFiles,
    });

    if (sent) {
      setContent("");
      setComposerAttachments([]);
      setComposerFiles([]);
    }
  }

  return (
    <form
      className="border-t border-line-soft px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
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
        aria-label={t("composerMessageAria")}
        className={clsx(inputBase, "min-h-[110px] resize-y")}
        data-testid="scratch-composer-input"
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
      <div className="mt-2">
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
          data-testid="scratch-composer-send"
          disabled={!canSubmitMessage || pending}
          type="submit"
        >
          {pending
            ? t("sending")
            : canRecover(status)
              ? t("recover")
              : t("send")}
        </button>
      </div>
    </form>
  );
}
