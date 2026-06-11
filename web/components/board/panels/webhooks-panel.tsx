"use client";

import type { ReactElement } from "react";

import { WebhooksPanelInner } from "@/components/webhooks/webhooks-panel-inner";

export interface WebhooksPanelProps {
  slug: string;
  // member+ on this project. Viewers still read the list (the project GET route
  // is viewer-scoped); writes (create/edit/delete/ping/replay/toggle) are gated
  // by the T13 components on canWrite, matching the member-scoped write routes.
  canWrite: boolean;
}

// Project-scoped webhook surface for the board "Webhooks" tab. A thin
// scope-parameterized wrapper over the shared inner panel — no settings endpoint
// (the global kill-switch is platform-only), apiBase derived from the slug.
export function WebhooksPanel({
  slug,
  canWrite,
}: WebhooksPanelProps): ReactElement {
  return (
    <WebhooksPanelInner
      apiBase={`/api/projects/${slug}/webhooks`}
      canWrite={canWrite}
    />
  );
}
