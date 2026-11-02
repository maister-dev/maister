import type {
  ScheduledAgentRequestSnapshot,
  ScheduledRequestState,
} from "@/lib/agents/scheduled-request";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

export async function ScheduledRequestEvidence({
  state,
  snapshot,
}: {
  state: ScheduledRequestState;
  snapshot?: ScheduledAgentRequestSnapshot;
}): Promise<ReactElement | null> {
  if (state === "not_applicable") return null;
  const t = await getTranslations("agentActivity");

  if (!snapshot)
    return (
      <p className="text-xs text-mute">{t(`scheduledRequestState.${state}`)}</p>
    );

  return (
    <details
      className="my-2 rounded-lg border border-line p-2"
      data-testid="scheduled-request-evidence"
    >
      <summary className="cursor-pointer text-sm">
        {t("scheduledRequest")}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm">
        {snapshot.requestAtLaunch ?? t("scheduledRequestState.empty")}
      </pre>
    </details>
  );
}
