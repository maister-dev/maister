import type { ReactElement } from "react";

import { ArrowUpTrayIcon, ShareIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import {
  button,
  danger,
  fieldLabel,
  inputClass,
  neutral,
  primary,
  Section,
  type GitSectionProps,
} from "@/components/workbench/git-panel-kit";
import { HandoffBranchForm } from "@/components/workbench/handoff-branch-form";

// ADR-181 D4: publish under the public name — the remote, the name while no
// upstream fixes it, and a force confirmed against the exact head it replaces;
// the handoff form rides along unchanged.
export function GitPublishSection({
  runId,
  state,
  busy,
  dirtyCount,
  mutate,
  actionButton,
}: GitSectionProps & { runId: string }): ReactElement {
  const t = useTranslations("workbenchGit");
  // The remote and the public name seed from the read this section mounted
  // with; after that the operator's choice stands across refreshes.
  const [remote, setRemote] = useState<string | null>(
    () =>
      state.publishedRemote ??
      (state.remotes.includes("origin")
        ? "origin"
        : (state.remotes[0] ?? null)),
  );
  const [nameValue, setNameValue] = useState(
    () => state.suggestedPublicBranch ?? "",
  );
  // D4: a non-fast-forward refusal's ref and remote head, while the operator
  // decides whether to replace it.
  const [forceTarget, setForceTarget] = useState<{
    ref: string;
    head: string;
  } | null>(null);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const nameFixed = state.upstream != null && state.upstream.remote === remote;

  // `expectedHead`: the remote head the operator confirmed replacing — a force
  // leases exactly it, so newer work that landed since is refused, not lost.
  function publish(expectedHead?: string): void {
    const requested = nameValue.trim();
    const suggested = state.suggestedPublicBranch ?? "";

    void mutate<{ publishedBranch?: string; publishedRef?: string }>(
      "exportBranch",
      "export-branch",
      {
        remote: remote ?? "origin",
        // Sent only when the operator edited the pre-filled name.
        ...(!nameFixed && requested !== "" && requested !== suggested
          ? { branchName: requested }
          : {}),
        snapshotDirty: false,
        ...(expectedHead ? { force: true, expectedHead } : { force: false }),
      },
      (result) => setPublishedRef(result?.publishedRef ?? null),
    ).then((failure) => {
      // A moved remote refuses again with its NEW head: confirm that one.
      setForceTarget(
        failure?.pushRejected === "non_fast_forward" &&
          failure.canForce &&
          typeof failure.remoteHead === "string" &&
          typeof failure.remoteRef === "string"
          ? { ref: failure.remoteRef, head: failure.remoteHead }
          : null,
      );
    });
  }

  return (
    <Section id="publish" title={t("section.publish")}>
      {state.remotes.length > 1 ? (
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("publish.remote")}</span>
          <select
            className={inputClass}
            value={remote ?? ""}
            onChange={(event) => setRemote(event.target.value)}
          >
            {state.remotes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {nameFixed ? null : (
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("publish.name")}</span>
          <input
            className={inputClass}
            data-testid="git-panel-name"
            value={nameValue}
            onChange={(event) => setNameValue(event.target.value)}
          />
        </label>
      )}
      {state.unpushedCommits !== null && state.unpushedCommits > 0 ? (
        <p className="m-0 font-mono text-[10px] text-ink-2">
          {t("publish.unpushed", { count: state.unpushedCommits })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actionButton({
          id: "exportBranch",
          tone: primary,
          blockedBy: dirtyCount > 0 ? t("hint.commitOrDiscardFirst") : null,
          icon: <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />,
          onClick: () => publish(),
        })}
        <button
          aria-expanded={handoffOpen}
          className={clsx(button, neutral)}
          data-testid="git-panel-handoff-open"
          disabled={busy !== null}
          type="button"
          onClick={() => setHandoffOpen((open) => !open)}
        >
          <ShareIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {t("publish.handoff")}
        </button>
      </div>
      {publishedRef ? (
        <p className="m-0 font-mono text-[10px] text-accent-4">
          {t("publish.done", { ref: publishedRef })}
        </p>
      ) : null}
      {handoffOpen ? <HandoffBranchForm runId={runId} /> : null}

      {forceTarget ? (
        <ConfirmDialog
          body={t("publish.forceBody", {
            ref: forceTarget.ref,
            head: forceTarget.head.slice(0, 12),
          })}
          busy={busy !== null}
          cancelLabel={t("cancel")}
          testId="git-panel-force-dialog"
          title={t("publish.forceTitle")}
          titleId="git-panel-force-title"
          onClose={() => setForceTarget(null)}
        >
          {state.pr?.state === "open" ? (
            <p
              className="m-0 text-[13px] leading-[1.5] text-body"
              data-testid="git-panel-force-pr"
            >
              {t("publish.forcePr", { number: state.pr.number ?? "?" })}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              className={clsx(button, neutral)}
              data-testid="git-panel-force-cancel"
              disabled={busy !== null}
              type="button"
              onClick={() => setForceTarget(null)}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(button, danger)}
              data-testid="git-panel-force-confirm"
              disabled={busy !== null}
              type="button"
              onClick={() => publish(forceTarget.head)}
            >
              <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("publish.forceConfirm", {
                head: forceTarget.head.slice(0, 12),
              })}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}
