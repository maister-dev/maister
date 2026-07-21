"use client";

import type { ComponentProps, ReactElement } from "react";

import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import {
  useEditorLock,
  type EditorLockSnapshot,
} from "@/components/flows/use-editor-lock";

export type AuthoredCapLockLabels = {
  // Non-ICU `$holder`: these are client-side templates, and `{holder}` would be
  // parsed as an ICU variable and throw when no value is supplied.
  readOnlyHeld: string;
  readOnlyUnknownHolder: string;
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
  const { sessionId, heldByMe, holderLabel } = useEditorLock({
    basePath: `/api/projects/${projectSlug}/catalog/caps/${capId}`,
    initialLock,
    enabled: canManage,
  });

  const effectiveCanManage = canManage && heldByMe;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      {canManage && !heldByMe ? (
        <p
          className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink-soft"
          data-testid="authored-cap-lock-banner"
          role="status"
        >
          {holderLabel
            ? lockLabels.readOnlyHeld.replace("$holder", holderLabel)
            : lockLabels.readOnlyUnknownHolder}
        </p>
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
