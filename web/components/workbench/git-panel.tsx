"use client";

import type { RunKind } from "@/lib/db/schema";
import type { GitPanelSection } from "@/lib/workbench-git/panel-link";
import type {
  WorkbenchGitAction,
  WorkbenchGitActionId,
} from "@/lib/workbench-git/policy";
import type { ReactElement, ReactNode } from "react";

import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { HandoffBranchForm } from "@/components/workbench/handoff-branch-form";

// ADR-181 D16 — the run git panel. The server decides: every button is enabled
// from `actions[]` (the ONE policy), every completed mutation re-reads
// git-state and refreshes the route, and an error is resolved from `code` +
// `details.reason` only — never from the server's message.

type GitState = {
  runId: string;
  runKind: RunKind;
  runStatus: string;
  internalBranch: string | null;
  publicBranch: string | null;
  publishedRemote: string | null;
  publishedAt: string | null;
  suggestedPublicBranch: string | null;
  upstream: { remote: string; branch: string } | null;
  remotes: string[];
  worktreePresent: boolean;
  workspaceRemoved: boolean;
  head: string | null;
  targetHead: string | null;
  dirty: { tracked: number; untracked: number } | null;
  unpushedCommits: number | null;
  aheadBehind: {
    base: { ahead: number; behind: number } | null;
    target: { ahead: number; behind: number } | null;
    published: { ahead: number; behind: number } | null;
  };
  publishedRemoteHead: string | null;
  remoteReachable: boolean;
  pr: {
    url: string;
    number: number | null;
    state: "open" | "merged" | "closed" | null;
    hasConflicts: boolean | null;
  } | null;
  busy: { name: string; claimedAt: string | null } | null;
  reattachSources: {
    local: string | null;
    published: string | null;
    archive: string | null;
  };
  rescueRefs: { ref: string; sha: string; createdAt: string }[];
  actions: WorkbenchGitAction[];
  commands: { checkout: string[]; restoreRescue: string | null };
  warnings: string[];
};

type ErrorBody = {
  code?: string;
  reason?: string;
  details?: { reason?: string };
  pushRejected?: string;
  canForce?: boolean;
};

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

export interface WorkbenchGitPanelProps {
  runId: string;
  runKind: RunKind;
  // A changing value (the run's SSE tick) re-reads git-state, debounced.
  refreshTick?: number;
  // The section the URL named (`?git=`), brought into view on open.
  initialSection?: GitPanelSection | null;
  syncDefaults?: WorkbenchGitSyncDefaults | null;
}

// The debounce for the refresh tick — a burst of stream events is one read.
const REFRESH_DEBOUNCE_MS = 400;

// The `details.reason` tokens the panel has copy for (T0.1's final set plus
// the C19 policy tokens). Anything else falls back to the error code.
const KNOWN_REASONS = new Set([
  "public_name_fixed",
  "public_branch_template_invalid",
  "clean_worktree",
  "dirty_worktree",
  "not_published",
  "published_remote_not_origin",
  "publish_stale",
  "target_branch_unknown",
  "provider_unsupported",
  "agent_requires_review",
  "base_branch_unknown",
  "pr_missing",
  "pr_closed",
  "target_drift",
  "review_only_field",
  "no_reattach_source",
  "worktree_path_occupied",
  "run_not_found",
  "busy",
  "human_owned",
  "live_workbench",
  "missing_workspace",
  "removed_workspace",
  "worktree_missing",
  "worktree_present",
  "unsupported_status",
  "unsupported_run",
  "promoted",
  "no_remote",
  "workspace_git_identity_invalid",
  "workspace_preservation_failed",
]);

// The error codes with panel copy; any other code reads as the generic error.
const KNOWN_CODES = new Set([
  "PRECONDITION",
  "CONFLICT",
  "CONFIG",
  "EXECUTOR_UNAVAILABLE",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "CRASH",
]);

const button =
  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const neutral =
  "border-line bg-paper text-mute hover:border-mute hover:text-ink-2";
const primary = "border-amber bg-amber text-white hover:bg-amber-2";
const danger = "border-amber-line bg-amber-soft text-amber hover:bg-ivory";
const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

function newMutationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

function Section({
  id,
  title,
  children,
}: {
  id: GitPanelSection | "commands";
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-line bg-paper p-3"
      data-testid={`git-panel-section-${id}`}
      id={`git-panel-section-${id}`}
    >
      <h3 className="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
        {title}
      </h3>
      {children}
    </section>
  );
}

function CopyLine({
  command,
  label,
}: {
  command: string;
  label: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-ivory px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
        {command}
      </code>
      <button
        aria-label={label}
        className="text-amber hover:text-amber-2"
        title={label}
        type="button"
        onClick={() => void navigator.clipboard?.writeText(command)}
      >
        <ClipboardDocumentIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function WorkbenchGitPanel({
  runId,
  refreshTick = 0,
  initialSection = null,
  syncDefaults = null,
}: WorkbenchGitPanelProps): ReactElement {
  const t = useTranslations("workbenchGit");
  const tl = useTranslations("workbenchLifecycle");
  const router = useRouter();
  const feedback = useFeedback();
  const [state, setState] = useState<GitState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<WorkbenchGitActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Typed input lives OUTSIDE the fetched state, so a git-state refresh never
  // discards it (a conditional unmount once lost an unsent answer).
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [rescue, setRescue] = useState<{
    ref: string;
    restoreCommand: string;
  } | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState<string | null>(null);
  const [forceAvailable, setForceAvailable] = useState(false);
  const [force, setForce] = useState(false);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [onto, setOnto] = useState<UpdateOnto>("target");
  const [strategy, setStrategy] = useState<"rebase" | "merge">(
    syncDefaults?.strategy ?? "rebase",
  );
  const [push, setPush] = useState<boolean | null>(null);
  const [resolver, setResolver] = useState(true);
  const [runnerId, setRunnerId] = useState(syncDefaults?.defaultRunnerId ?? "");
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTickRef = useRef(refreshTick);

  const load = useCallback(async (): Promise<void> => {
    const reqId = (reqIdRef.current += 1);

    try {
      const res = await fetch(`/api/runs/${runId}/git-state`);

      if (reqId !== reqIdRef.current) return;
      if (!res.ok) {
        setLoadFailed(true);

        return;
      }

      const body = await readJson<GitState>(res);

      // Latest-wins: a response superseded by a newer read is dropped.
      if (!body || reqId !== reqIdRef.current) return;
      setLoadFailed(false);
      setState(body);
    } catch {
      if (reqId === reqIdRef.current) setLoadFailed(true);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read on the run's stream tick, debounced; the mount itself is not a tick.
  useEffect(() => {
    if (refreshTick === lastTickRef.current) return;
    lastTickRef.current = refreshTick;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refreshTick, load]);

  // The remote and the public name seed from the first read; after that the
  // operator's choice stands across refreshes.
  useEffect(() => {
    if (!state) return;
    setRemote(
      (current) =>
        current ??
        state.publishedRemote ??
        (state.remotes.includes("origin")
          ? "origin"
          : (state.remotes[0] ?? null)),
    );
    setNameValue((current) => current ?? state.suggestedPublicBranch ?? "");
    // The server pushes a published branch by default (`push ?? published`).
    setPush(
      (current) =>
        current ?? (state.publicBranch !== null || state.pr !== null),
    );
  }, [state]);

  useEffect(() => {
    if (!state || !initialSection) return;
    document
      .getElementById(`git-panel-section-${initialSection}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [state, initialSection]);

  function errorText(body: ErrorBody | null): string {
    if (body?.pushRejected === "non_fast_forward") {
      return t("errors.non_fast_forward");
    }

    const reason = body?.details?.reason ?? body?.reason;

    if (reason && KNOWN_REASONS.has(reason)) return t(`errors.${reason}`);
    if (body?.code && KNOWN_CODES.has(body.code)) {
      return t(`errors.${body.code}`);
    }

    return t("errors.generic");
  }

  // One mutation shape: POST, then re-read git-state + refresh the route on
  // success; the typed refusal resolves to copy. `onOk` returning false marks
  // an answered-but-unsuccessful outcome (an update's conflict): no success
  // toast, the section renders it instead.
  async function mutate<T>(
    id: WorkbenchGitActionId,
    path: string,
    body: Record<string, unknown>,
    onOk: (result: T | null) => boolean | void,
  ): Promise<ErrorBody | null> {
    setBusy(id);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const failure = (await readJson<ErrorBody>(res)) ?? {};

        setError(errorText(failure));

        return failure;
      }

      if (onOk(await readJson<T>(res)) !== false) {
        feedback.success({
          message: t(`done.${id}`),
          mutationId: newMutationId(),
        });
      }
      await load();
      router.refresh();

      return null;
    } catch {
      setError(t("errors.EXECUTOR_UNAVAILABLE"));

      return { code: "EXECUTOR_UNAVAILABLE" };
    } finally {
      setBusy(null);
    }
  }

  const action = (id: WorkbenchGitActionId): WorkbenchGitAction | undefined =>
    state?.actions.find((a) => a.id === id);
  const dirtyCount = state?.dirty
    ? state.dirty.tracked + state.dirty.untracked
    : 0;

  // An action button: enabled by the server's policy, plus the panel's own
  // local preconditions (a dirty tree cannot publish; a clean one has nothing
  // to commit or discard), each with its reason as the tooltip. A render
  // function, not a nested component, so a re-render never remounts it.
  function actionButton({
    id,
    tone = neutral,
    icon,
    blockedBy,
    onClick,
  }: {
    id: WorkbenchGitActionId;
    tone?: string;
    icon?: ReactNode;
    blockedBy?: string | null;
    onClick: () => void;
  }): ReactElement {
    const policy = action(id);
    const disabledReason = policy?.enabled
      ? (blockedBy ?? null)
      : t(`disabledReason.${policy?.disabledReason ?? "unsupported-status"}`);

    return (
      <button
        className={clsx(button, tone)}
        data-testid={`git-panel-action-${id}`}
        disabled={busy !== null || disabledReason !== null}
        title={disabledReason ?? undefined}
        type="button"
        onClick={onClick}
      >
        {icon}
        {busy === id
          ? tl("busy", { action: tl(`action.${id}`) })
          : tl(`action.${id}`)}
      </button>
    );
  }

  function publish(): void {
    const requested = (nameValue ?? "").trim();
    const suggested = state?.suggestedPublicBranch ?? "";
    const nameFixed =
      state?.upstream != null && state.upstream.remote === remote;

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
        force,
      },
      (result) => {
        setForceAvailable(false);
        setForce(false);
        setPublishedRef(result?.publishedRef ?? null);
      },
    ).then((failure) => {
      if (failure?.pushRejected === "non_fast_forward" && failure.canForce) {
        setForceAvailable(true);
      }
    });
  }

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

  function reattach(): void {
    void mutate("reattach", "reattach", {}, () => undefined);
  }

  function update(): void {
    const inReview = state?.runStatus === "Review";

    void mutate<UpdateResult>(
      "update",
      "sync",
      {
        onto,
        strategy,
        push: push ?? false,
        // D9: the resolver's Review→Running CAS exists only in Review.
        agent: inReview && resolver,
        ...(inReview && resolver && runnerId ? { runnerId } : {}),
      },
      (result) => {
        setUpdateResult(result);

        return result?.outcome !== "conflict";
      },
    );
  }

  const usable = state
    ? state.worktreePresent && !state.workspaceRemoved
    : false;
  const nameFixed = state?.upstream != null && state.upstream.remote === remote;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-line bg-ivory p-3"
      data-testid="git-panel"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink">
          {t("title")}
        </h2>
        {state?.internalBranch ? (
          <code className="rounded border border-line bg-paper px-1.5 py-px font-mono text-[10px] text-ink-2">
            {state.internalBranch}
          </code>
        ) : null}
        {state?.publicBranch ? (
          <span
            className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[10px] text-accent-4"
            data-testid="git-panel-public-chip"
          >
            {t("publicChip", {
              remote: state.publishedRemote ?? "",
              branch: state.publicBranch,
            })}
          </span>
        ) : null}
        {state?.pr ? (
          <a
            className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[10px] text-ink-2 hover:text-amber"
            data-testid="git-panel-pr-chip"
            href={state.pr.url}
            rel="noreferrer"
            target="_blank"
          >
            {t("prChip", {
              number: state.pr.number ?? "?",
              state: t(`prState.${state.pr.state ?? "unknown"}`),
            })}
          </a>
        ) : null}
        {state?.busy ? (
          <span
            className="rounded-full border border-amber-line bg-amber-soft px-2 py-px font-mono text-[10px] text-amber"
            data-testid="git-panel-busy"
          >
            {t("busy", { name: state.busy.name })}
          </span>
        ) : null}
      </header>

      {!state && !loadFailed ? (
        <p aria-busy="true" className="font-mono text-[10px] text-mute">
          {t("loading")}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="font-mono text-[10px] text-amber" role="alert">
          {t("loadFailed")}
        </p>
      ) : null}

      {state && usable ? (
        <>
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
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {t("commit.message")}
                  </span>
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
          </Section>

          <Section id="publish" title={t("section.publish")}>
            {state.remotes.length > 1 ? (
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                  {t("publish.remote")}
                </span>
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
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                  {t("publish.name")}
                </span>
                <input
                  className={inputClass}
                  data-testid="git-panel-name"
                  value={nameValue ?? ""}
                  onChange={(event) => setNameValue(event.target.value)}
                />
              </label>
            )}
            {state.unpushedCommits !== null && state.unpushedCommits > 0 ? (
              <p className="m-0 font-mono text-[10px] text-ink-2">
                {t("publish.unpushed", { count: state.unpushedCommits })}
              </p>
            ) : null}
            {forceAvailable ? (
              <label className="flex items-center gap-2 font-mono text-[10px] text-ink-2">
                <input
                  checked={force}
                  data-testid="git-panel-force"
                  type="checkbox"
                  onChange={(event) => setForce(event.target.checked)}
                />
                {t("publish.force")}
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {actionButton({
                id: "exportBranch",
                tone: primary,
                blockedBy:
                  dirtyCount > 0 ? t("hint.commitOrDiscardFirst") : null,
                icon: (
                  <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />
                ),
                onClick: publish,
              })}
              <button
                className={clsx(button, neutral)}
                data-testid="git-panel-handoff-open"
                disabled={busy !== null}
                type="button"
                onClick={() => setHandoffOpen((open) => !open)}
              >
                {t("publish.handoff")}
              </button>
            </div>
            {publishedRef ? (
              <p className="m-0 font-mono text-[10px] text-accent-4">
                {t("publish.done", { ref: publishedRef })}
              </p>
            ) : null}
            {handoffOpen ? <HandoffBranchForm runId={runId} /> : null}
          </Section>

          <Section id="update" title={t("section.update")}>
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                {t("update.onto")}
              </legend>
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
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                {t("update.strategy")}
              </span>
              <select
                className={inputClass}
                data-testid="git-panel-update-strategy"
                value={strategy}
                onChange={(event) =>
                  setStrategy(
                    event.target.value === "merge" ? "merge" : "rebase",
                  )
                }
              >
                <option value="rebase">{t("update.rebase")}</option>
                <option value="merge">{t("update.merge")}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 font-mono text-[10px] text-ink-2">
              <input
                checked={push ?? false}
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
                {resolver &&
                syncDefaults &&
                syncDefaults.runnerOptions.length > 0 ? (
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                      {t("update.runner")}
                    </span>
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
                blockedBy:
                  dirtyCount > 0 ? t("hint.commitOrDiscardFirst") : null,
                icon: (
                  <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
                ),
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
          </Section>

          <Section id="commands" title={t("section.commands")}>
            {state.commands.checkout.length > 0 ? (
              <>
                <span className="font-mono text-[10px] text-mute">
                  {t("commands.checkout")}
                </span>
                {state.commands.checkout.map((command) => (
                  <CopyLine
                    key={command}
                    command={command}
                    label={t("commands.copy")}
                  />
                ))}
              </>
            ) : (
              <p className="m-0 font-mono text-[10px] text-mute">
                {t("commands.unpublished")}
              </p>
            )}
            {state.commands.restoreRescue ? (
              <>
                <span className="font-mono text-[10px] text-mute">
                  {t("commands.restoreRescue")}
                </span>
                <CopyLine
                  command={state.commands.restoreRescue}
                  label={t("commands.copy")}
                />
              </>
            ) : null}
          </Section>
        </>
      ) : null}

      {state && !usable ? (
        <Section id="reattach" title={t("section.reattach")}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[10px] text-ink-2">
            {(["local", "published", "archive"] as const).map((source) => (
              <li key={source}>
                {t(`reattach.${source}`)}:{" "}
                {state.reattachSources[source]?.slice(0, 12) ?? "—"}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {actionButton({
              id: "reattach",
              tone: primary,
              icon: (
                <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
              ),
              onClick: reattach,
            })}
          </div>
        </Section>
      ) : null}

      {error ? (
        <p
          aria-live="assertive"
          className="m-0 font-mono text-[10px] font-semibold text-amber"
          data-testid="git-panel-error"
          role="alert"
        >
          {error}
        </p>
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
    </div>
  );
}
