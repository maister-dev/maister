import type { ReactElement } from "react";

import { ArrowPathIcon, ArrowUpTrayIcon } from "@heroicons/react/24/outline";
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

// ADR-181 D9: the refs an update applies onto.
type UpdateOnto = "target" | "base" | "published";

const UPDATE_ONTO: readonly UpdateOnto[] = ["target", "base", "published"];

// `POST /sync`'s 200/202 body (`SyncRunResponse`).
type UpdateResult = {
  attemptId: string;
  outcome: "noop" | "synced" | "conflict" | "agent_launched";
  behind: number;
  pushed: boolean;
  conflictedFiles: string[];
};

// The update's seeds the page already knows: the project strategy default and,
// for the Review-only AI resolver, the runner choice (ADR-141).
export type WorkbenchGitSyncDefaults = {
  strategy: "rebase" | "merge";
  runnerOptions: { id: string; label: string }[];
  defaultRunnerId: string | null;
};

// ADR-181 D9: update onto base, target or the publication; a conflict leaves
// the tree where it started and lists the paths. (C) An update whose push
// would drop commits only the publication has is refused before anything
// moves: the operator brings them in first, or overwrites exactly that head.
export function GitUpdateSection({
  runId,
  state,
  busy,
  dirtyCount,
  mutate,
  actionButton,
  syncDefaults,
}: GitSectionProps & {
  runId: string;
  syncDefaults: WorkbenchGitSyncDefaults | null;
}): ReactElement {
  const t = useTranslations("workbenchGit");
  const [onto, setOnto] = useState<UpdateOnto>("target");
  const [strategy, setStrategy] = useState<"rebase" | "merge">(
    syncDefaults?.strategy ?? "rebase",
  );
  // The server pushes a published branch by default (`push ?? published`).
  const [push, setPush] = useState(
    () => state.publicBranch !== null || state.pr !== null,
  );
  const [resolver, setResolver] = useState(true);
  const [runnerId, setRunnerId] = useState(syncDefaults?.defaultRunnerId ?? "");
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  // (C) the refused update and what its push would drop, while the operator
  // decides.
  const [diverged, setDiverged] = useState<{
    ref: string;
    head: string;
    count: number;
    body: Record<string, unknown>;
  } | null>(null);

  // `expectedRemoteHead`: the publication head the operator confirmed
  // replacing — the push leases exactly it, so commits that landed since are
  // refused again, naming the new head.
  function send(body: Record<string, unknown>, expectedRemoteHead?: string) {
    void mutate<UpdateResult>(
      "update",
      "sync",
      expectedRemoteHead ? { ...body, expectedRemoteHead } : body,
      (result) => {
        setUpdateResult(result);

        return result?.outcome !== "conflict";
      },
    ).then((failure) => {
      setDiverged(
        failure?.details?.reason === "publication_diverged" &&
          typeof failure.remoteHead === "string" &&
          typeof failure.remoteRef === "string" &&
          typeof failure.remoteOnlyCommits === "number"
          ? {
              ref: failure.remoteRef,
              head: failure.remoteHead,
              count: failure.remoteOnlyCommits,
              body,
            }
          : null,
      );
    });
  }

  function update(): void {
    const inReview = state.runStatus === "Review";

    send({
      onto,
      strategy,
      push,
      // D9: the resolver's Review→Running CAS exists only in Review.
      agent: inReview && resolver,
      ...(inReview && resolver && runnerId ? { runnerId } : {}),
    });
  }

  // The same update onto the publication brings its commits in — nothing is
  // dropped, and the next update onto the target has nothing to ask about.
  function updateOntoPublication(refused: Record<string, unknown>): void {
    setOnto("published");
    send({ ...refused, onto: "published" });
  }

  return (
    <Section id="update" title={t("section.update")}>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className={clsx("mb-1", fieldLabel)}>{t("update.onto")}</legend>
        {UPDATE_ONTO.map((option) => {
          const counts = state.aheadBehind[option];
          // D9: `published` needs a publication (`not_published`).
          const unavailable =
            option === "published" && state.publicBranch === null;

          return (
            <label
              key={option}
              className={clsx(
                "flex items-center gap-2 font-mono text-[10px] text-ink-2",
                unavailable && "opacity-50",
              )}
            >
              <input
                checked={onto === option}
                data-testid={`git-panel-update-onto-${option}`}
                disabled={unavailable}
                name={`git-panel-update-onto-${runId}`}
                type="radio"
                value={option}
                onChange={() => setOnto(option)}
              />
              {t(`update.${option}`)}
              <span className="text-mute">
                {counts
                  ? t("update.aheadBehind", {
                      ahead: counts.ahead,
                      behind: counts.behind,
                    })
                  : "—"}
              </span>
            </label>
          );
        })}
      </fieldset>
      {/* D3: the one network read — the remote moved past the last
          fetch (someone pushed to the publication). */}
      {state.publishedRemoteHead !== null &&
      state.publishedTrackingHead !== null &&
      state.publishedRemoteHead !== state.publishedTrackingHead ? (
        <p
          className="m-0 font-mono text-[10px] text-amber"
          data-testid="git-panel-update-remote-moved"
          role="status"
        >
          {t("update.remoteMoved")}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("update.strategy")}</span>
        <select
          className={inputClass}
          data-testid="git-panel-update-strategy"
          value={strategy}
          onChange={(event) =>
            setStrategy(event.target.value === "merge" ? "merge" : "rebase")
          }
        >
          <option value="rebase">{t("update.rebase")}</option>
          <option value="merge">{t("update.merge")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2 font-mono text-[10px] text-ink-2">
        <input
          checked={push}
          data-testid="git-panel-update-push"
          type="checkbox"
          onChange={(event) => setPush(event.target.checked)}
        />
        {t("update.push")}
      </label>
      {state.runStatus === "Review" ? (
        <>
          <label className="flex items-center gap-2 font-mono text-[10px] text-ink-2">
            <input
              checked={resolver}
              data-testid="git-panel-update-agent"
              type="checkbox"
              onChange={(event) => setResolver(event.target.checked)}
            />
            {t("update.agent")}
          </label>
          {resolver && syncDefaults && syncDefaults.runnerOptions.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("update.runner")}</span>
              <select
                className={inputClass}
                data-testid="git-panel-update-runner"
                value={runnerId}
                onChange={(event) => setRunnerId(event.target.value)}
              >
                <option value="">{t("update.runnerDefault")}</option>
                {syncDefaults.runnerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actionButton({
          id: "update",
          tone: primary,
          blockedBy: dirtyCount > 0 ? t("hint.commitOrDiscardFirst") : null,
          icon: <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />,
          onClick: update,
        })}
      </div>
      {updateResult ? (
        <div
          className="flex flex-col gap-1 font-mono text-[10px] text-ink-2"
          data-testid="git-panel-update-result"
          role="status"
        >
          <span>
            {t(`update.outcome.${updateResult.outcome}`, {
              behind: updateResult.behind,
            })}
          </span>
          {updateResult.conflictedFiles.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {updateResult.conflictedFiles.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {diverged ? (
        <ConfirmDialog
          body={t("update.divergedBody", {
            ref: diverged.ref,
            head: diverged.head.slice(0, 12),
            count: diverged.count,
          })}
          busy={busy !== null}
          cancelLabel={t("cancel")}
          testId="git-panel-diverged-dialog"
          title={t("update.divergedTitle")}
          titleId="git-panel-diverged-title"
          onClose={() => setDiverged(null)}
        >
          {state.pr?.state === "open" ? (
            <p
              className="m-0 text-[13px] leading-[1.5] text-body"
              data-testid="git-panel-diverged-pr"
            >
              {t("update.divergedPr", { number: state.pr.number ?? "?" })}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className={clsx(button, primary)}
              data-testid="git-panel-diverged-onto"
              disabled={busy !== null}
              type="button"
              onClick={() => updateOntoPublication(diverged.body)}
            >
              <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("update.divergedOnto")}
            </button>
            <button
              className={clsx(button, neutral)}
              data-testid="git-panel-diverged-cancel"
              disabled={busy !== null}
              type="button"
              onClick={() => setDiverged(null)}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(button, danger)}
              data-testid="git-panel-diverged-confirm"
              disabled={busy !== null}
              type="button"
              onClick={() => send(diverged.body, diverged.head)}
            >
              <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("update.divergedConfirm", { count: diverged.count })}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}
