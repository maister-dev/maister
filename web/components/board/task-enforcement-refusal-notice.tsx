"use client";

import type { ReactElement } from "react";
import type { NodeEnforcementRefusal } from "@/lib/flows/enforcement-refusal";

import { useTranslations } from "next-intl";

const AGENT_LABELS: Readonly<
  Record<NodeEnforcementRefusal["capabilityAgent"], string>
> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  mimo: "MiMo",
};

export function TaskEnforcementRefusalNotice({
  refusal,
}: {
  refusal: NodeEnforcementRefusal;
}): ReactElement {
  const t = useTranslations("launch");

  return (
    <p className="text-sm text-danger" role="alert">
      {t("admission.enforcementRefused", {
        node: refusal.nodeId,
        capability: t(`admission.enforcementClass.${refusal.capabilityClass}`),
        agent: AGENT_LABELS[refusal.capabilityAgent],
      })}
    </p>
  );
}
