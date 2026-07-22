"use client";

import type { ComponentProps, ReactElement } from "react";

import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import {
  formatHolderLabel,
  useEditorLock,
  type EditorLockSnapshot,
} from "@/components/flows/use-editor-lock";

export type AuthoredCapLockLabels = {
  // Non-ICU `$holder`: these are client-side templates, and `{holder}` would be
  // parsed as an ICU variable and throw when no value is supplied.
  readOnlyHeld: string;
  readOnlyUnknownHolder: string;
  // In-place recovery affordance shown on the read-only banner after a takeover.
  retry: string;
};

// (ADR-149) Owns the authored-capability editor's session edit-lock: acquire on
// open, 60s keep-alive, ordered release, and the read-only presentation when the
// lock is not held. `canManage` from the server is the authorization boundary;
// the lock only narrows it further, never widens it.
export function AuthoredCapLockShell({
  projectSlug,
  capId,
  canManage,
  initialLock,
  lockLabels,
  ...editorProps
}: Omit<
  ComponentProps<typeof FlowEditorTabs>,
  "canManage" | "lockSessionId"
> & {
  canManage: boolean;
  initialLock: EditorLockSnapshot;
  lockLabels: AuthoredCapLockLabels;
}): ReactElement {
  const { sessionId, heldByMe, holderLabel, confirmed, retry } = useEditorLock({
    basePath: `/api/projects/${projectSlug}/catalog/caps/${capId}`,
    initialLock,
    enabled: canManage,
  });

  // `confirmed` is required, not just `heldByMe`: the RSC snapshot starts
  // optimistic (`heldByMe: !held`) to avoid a read-only flash, so without this
  // the save/publish buttons are live BEFORE the acquire round-trips. A submit
  // in that window fails the server-side `assertHoldsLock` and — because these
  // are server actions — the CONFLICT is caught by this route's `error.tsx`.
  // This is STRICTER than the studio twin, whose main read-only gate is
  // `lockHeldByMe` alone: studio writes via `fetch` and recovers with `markLost`
  // instead of unwinding to an error boundary, so it does not need `confirmed`.
  const effectiveCanManage = canManage && heldByMe && confirmed;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      {canManage && !heldByMe ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink-soft"
          data-testid="authored-cap-lock-banner"
          role="status"
        >
          <span>
            {holderLabel
              ? formatHolderLabel(lockLabels.readOnlyHeld, holderLabel)
              : lockLabels.readOnlyUnknownHolder}
          </span>
          <button
            className="shrink-0 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-surface"
            type="button"
            onClick={retry}
          >
            {lockLabels.retry}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <FlowEditorTabs
          {...editorProps}
          canManage={effectiveCanManage}
          capId={capId}
          lockSessionId={sessionId}
          projectSlug={projectSlug}
        />
      </div>
    </div>
  );
}
