import type { ReactElement } from "react";

import { CheckIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import {
  button,
  CopyLine,
  danger,
  fieldLabel,
  inputClass,
  neutral,
  primary,
  Section,
  type GitSectionProps,
} from "@/components/workbench/git-panel-kit";

// ADR-181 D7/D8: the tree — commit, and a preserve-first discard whose rescue
// refs survive, newest first.
export function GitTreeSection({
  state,
  busy,
  dirtyCount,
  mutate,
  actionButton,
}: GitSectionProps): ReactElement {
  const t = useTranslations("workbenchGit");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [rescue, setRescue] = useState<{
    ref: string;
    restoreCommand: string;
  } | null>(null);

  function commit(): void {
    void mutate("snapshotCommit", "snapshot-commit", { commitMessage }, () => {
      setCommitOpen(false);
      setCommitMessage("");
    });
  }

  function discard(): void {
    void mutate<{ rescueRef: string; restoreCommand: string }>(
      "discardChanges",
      "discard-changes",
      {},
      (result) => {
        if (result?.rescueRef) {
          setRescue({
            ref: result.rescueRef,
            restoreCommand: result.restoreCommand,
          });
        }
      },
    ).then(() => setDiscardOpen(false));
  }

  return (
    <Section id="tree" title={t("section.tree")}>
      <p className="m-0 font-mono text-[10px] text-ink-2">
        {state.dirty && dirtyCount > 0
          ? t("tree.dirty", {
              tracked: state.dirty.tracked,
              untracked: state.dirty.untracked,
            })
          : t("tree.clean")}
      </p>
      <div className="flex flex-wrap gap-2">
        {actionButton({
          id: "snapshotCommit",
          blockedBy: dirtyCount === 0 ? t("hint.cleanTree") : null,
          icon: <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />,
          onClick: () => setCommitOpen(true),
        })}
        {actionButton({
          id: "discardChanges",
          tone: danger,
          blockedBy: dirtyCount === 0 ? t("hint.cleanTree") : null,
          icon: <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />,
          onClick: () => setDiscardOpen(true),
        })}
      </div>
      {commitOpen ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("commit.message")}</span>
            <textarea
              className={clsx(inputClass, "min-h-[72px] py-2")}
              data-testid="git-panel-commit-message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              className={clsx(button, neutral)}
              disabled={busy !== null}
              type="button"
              onClick={() => setCommitOpen(false)}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(button, primary)}
              data-testid="git-panel-commit-submit"
              disabled={busy !== null || commitMessage.trim() === ""}
              type="button"
              onClick={commit}
            >
              <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("commit.submit")}
            </button>
          </div>
        </div>
      ) : null}
      {rescue ? (
        <div
          className="flex flex-col gap-1 rounded-md border border-line bg-ivory p-2"
          data-testid="git-panel-rescue-result"
        >
          <span className="font-mono text-[10px] text-ink-2">
            {t("discard.done", { ref: rescue.ref })}
          </span>
          <CopyLine
            command={rescue.restoreCommand}
            label={t("commands.copy")}
          />
        </div>
      ) : null}
      {/* D8: every discard's rescue ref survives, newest first. */}
      {state.rescueRefs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("tree.rescueRefs")}</span>
          <ul
            className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[10px] text-ink-2"
            data-testid="git-panel-rescue-refs"
          >
            {state.rescueRefs.map((rescueRef) => (
              <li key={rescueRef.ref}>
                <code>{rescueRef.ref}</code>{" "}
                <span className="text-mute">{rescueRef.sha.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {discardOpen ? (
        <ConfirmDialog
          body={t("discard.body")}
          busy={busy !== null}
          cancelLabel={t("cancel")}
          testId="git-panel-discard-dialog"
          title={t("discard.title")}
          titleId="git-panel-discard-title"
          onClose={() => setDiscardOpen(false)}
        >
          <div className="flex justify-end gap-2">
            <button
              className={clsx(button, neutral)}
              disabled={busy !== null}
              type="button"
              onClick={() => setDiscardOpen(false)}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(button, danger)}
              data-testid="git-panel-discard-confirm"
              disabled={busy !== null}
              type="button"
              onClick={discard}
            >
              <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("discard.confirm")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}
