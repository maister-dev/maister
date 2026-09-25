import type { RunKind } from "@/lib/db/schema";
import type { GitPanelSection } from "@/lib/workbench-git/panel-link";
import type {
  WorkbenchGitAction,
  WorkbenchGitActionId,
} from "@/lib/workbench-git/policy";
import type { ReactElement, ReactNode } from "react";

import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";

// ADR-181 D16: what every section of the run git panel shares — the git-state
// shape, the typed refusal, the one mutation and action-button seams the panel
// hands down, and the section chrome.

export type GitState = {
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
  publishedTrackingHead: string | null;
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
  prDefaults: { title: string; body: string; targetBranch: string } | null;
  commands: { checkout: string[]; restoreRescue: string | null };
  warnings: string[];
};

export type ErrorBody = {
  code?: string;
  reason?: string;
  details?: { reason?: string };
  pushRejected?: string;
  canForce?: boolean;
  // ADR-181 D4: what a force would replace — the head the retry leases.
  remoteHead?: string | null;
  remoteRef?: string;
  // ADR-181 (C): with `publication_diverged`, the commits only the publication
  // has — what an update's push would drop.
  remoteOnlyCommits?: number | null;
};

// One mutation shape: POST, then re-read git-state + refresh the route on
// success; the typed refusal resolves to copy. `onOk` returning false marks
// an answered-but-unsuccessful outcome (an update's conflict): no success
// toast, the section renders it instead.
export type GitMutate = <T>(
  id: WorkbenchGitActionId,
  path: string,
  body: Record<string, unknown>,
  onOk: (result: T | null) => boolean | void,
) => Promise<ErrorBody | null>;

// An action button enabled by the server's policy plus the section's own local
// precondition (`blockedBy`), each with its reason as the tooltip.
export type GitActionButton = (args: {
  id: WorkbenchGitActionId;
  tone?: string;
  icon?: ReactNode;
  blockedBy?: string | null;
  onClick: () => void;
}) => ReactElement;

// What the panel hands every section: the read it rendered from and the seams
// every write goes through.
export type GitSectionProps = {
  state: GitState;
  busy: WorkbenchGitActionId | null;
  dirtyCount: number;
  mutate: GitMutate;
  actionButton: GitActionButton;
};

export const button =
  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
export const neutral =
  "border-line bg-paper text-mute hover:border-mute hover:text-ink-2";
export const primary = "border-amber bg-amber text-white hover:bg-amber-2";
export const danger =
  "border-amber-line bg-amber-soft text-amber hover:bg-ivory";
export const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";
export const fieldLabel =
  "font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute";

export function Section({
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

export function CopyLine({
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
