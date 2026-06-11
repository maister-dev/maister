"use client";

import type { ReactElement } from "react";

import { WebhooksPanelInner } from "@/components/webhooks/webhooks-panel-inner";

// Platform (admin) webhook surface for the settings page. Admin-only page, so
// canWrite is always true; the global kill-switch is wired here (project scope
// has no settings endpoint). All CRUD/ping/deliveries/replay is scoped by the
// `/api/admin/webhooks` base inside the shared inner panel.
export function WebhooksPanel(): ReactElement {
  return (
    <div className="mt-6 border-t border-line pt-6">
      <WebhooksPanelInner
        canWrite
        apiBase="/api/admin/webhooks"
        settingsApiBase="/api/admin/webhook-settings"
      />
    </div>
  );
}
