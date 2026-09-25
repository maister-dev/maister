"use client";

import type { RunKind } from "@/lib/db/schema";
import type { GitPanelSection } from "@/lib/workbench-git/panel-link";
import type {
  WorkbenchGitAction,
  WorkbenchGitActionId,
} from "@/lib/workbench-git/policy";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { useFeedback } from "@/components/feedback/feedback-provider";
import { GitCommandsSection } from "@/components/workbench/git-panel-commands";
import {
  button,
  neutral,
  type ErrorBody,
  type GitActionButton,
  type GitMutate,
  type GitSectionProps,
  type GitState,
} from "@/components/workbench/git-panel-kit";
import { GitPrSection } from "@/components/workbench/git-panel-pr";
import { GitPublishSection } from "@/components/workbench/git-panel-publish";
import { GitReattachSection } from "@/components/workbench/git-panel-reattach";
import { GitTreeSection } from "@/components/workbench/git-panel-tree";
import {
  GitUpdateSection,
  type WorkbenchGitSyncDefaults,
} from "@/components/workbench/git-panel-update";

export type { WorkbenchGitSyncDefaults };

// ADR-181 D16 — the run git panel. The server decides: every button is enabled
// from `actions[]` (the ONE policy), every completed mutation re-reads
// git-state and refreshes the route, and an error is resolved from `code` +
// `details.reason` only — never from the server's message. Each section owns
// its typed input (a git-state refresh re-renders it, never remounts it); this
// component owns the read, the one mutation shape and the shared chrome.

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
  "target_locked",
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

// D3: the sub-reads `git-state` names when they degraded; a token without copy
// reads as "other git facts".
const KNOWN_WARNINGS = new Set([
  "head",
  "targetHead",
  "dirty",
  "upstream",
  "remotes",
  "aheadBehind.base",
  "aheadBehind.target",
  "aheadBehind.published",
  "unpushedCommits",
  "publishedRemoteHead",
  "reattachSources",
  "rescueRefs",
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

function newMutationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
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
  // `git-state` is member-level (`recoverRun`): a viewer's 403 is a role, not
  // a failure.
  const [membersOnly, setMembersOnly] = useState(false);
  const [busy, setBusy] = useState<WorkbenchGitActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTickRef = useRef(refreshTick);

  const load = useCallback(async (): Promise<void> => {
    const reqId = (reqIdRef.current += 1);

    try {
      const res = await fetch(`/api/runs/${runId}/git-state`);

      if (reqId !== reqIdRef.current) return;
      if (res.status === 403) {
        setMembersOnly(true);

        return;
      }
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

  const mutate: GitMutate = async (id, path, body, onOk) => {
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

      if (onOk(await readJson(res)) !== false) {
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
  };

  const action = (id: WorkbenchGitActionId): WorkbenchGitAction | undefined =>
    state?.actions.find((a) => a.id === id);
  const dirtyCount = state?.dirty
    ? state.dirty.tracked + state.dirty.untracked
    : 0;

  // An action button: enabled by the server's policy, plus the panel's own
  // local preconditions (a dirty tree cannot publish; a clean one has nothing
  // to commit or discard), each with its reason as the tooltip. A render
  // function, not a nested component, so a re-render never remounts it.
  const actionButton: GitActionButton = ({
    id,
    tone = neutral,
    icon,
    blockedBy,
    onClick,
  }) => {
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
  };

  const usable = state
    ? state.worktreePresent && !state.workspaceRemoved
    : false;
  const sectionProps: GitSectionProps | null = state
    ? { state, busy, dirtyCount, mutate, actionButton }
    : null;

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
              state:
                state.runKind === "scratch"
                  ? t("prState.notTracked", {
                      state: t(`prState.${state.pr.state ?? "open"}`),
                    })
                  : t(`prState.${state.pr.state ?? "unknown"}`),
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

      {state && state.warnings.length > 0 ? (
        <p
          className="m-0 font-mono text-[10px] text-amber"
          data-testid="git-panel-warnings"
          role="status"
        >
          {t("warnings.note", {
            facts: [
              ...new Set(
                state.warnings.map((warning) =>
                  KNOWN_WARNINGS.has(warning)
                    ? t(`warnings.fact.${warning}`)
                    : t("warnings.fact.other"),
                ),
              ),
            ].join(", "),
          })}
        </p>
      ) : null}
      {!state && !loadFailed && !membersOnly ? (
        <p aria-busy="true" className="font-mono text-[10px] text-mute">
          {t("loading")}
        </p>
      ) : null}
      {membersOnly ? (
        <p
          className="m-0 font-mono text-[10px] text-mute"
          data-testid="git-panel-members-only"
          role="status"
        >
          {t("membersOnly")}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="font-mono text-[10px] text-amber" role="alert">
          {t("loadFailed")}
        </p>
      ) : null}

      {sectionProps && usable ? (
        <>
          <GitTreeSection {...sectionProps} />
          <GitPublishSection {...sectionProps} runId={runId} />
          <GitUpdateSection
            {...sectionProps}
            runId={runId}
            syncDefaults={syncDefaults}
          />
          <GitPrSection {...sectionProps} />
          <GitCommandsSection state={sectionProps.state} />
        </>
      ) : null}

      {sectionProps && !usable ? (
        <GitReattachSection {...sectionProps} />
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
    </div>
  );
}
