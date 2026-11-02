"use client";
import type { ReactNode } from "react";
import type { RunPeekNode } from "@/lib/runs/peek-types";

import { useTranslations } from "next-intl";

export function FlowNodeDetails({ node }: { node: RunPeekNode }): ReactNode {
  const t = useTranslations("runPeek");
  const statusT = useTranslations("run.nodeStatus");

  return (
    <dl
      className="space-y-1 rounded border border-line p-2 text-sm"
      data-testid="peek-node-details"
    >
      <dt>{t("node")}</dt>
      <dd className="break-words">
        {node.label} · {node.type}
      </dd>
      <dt>{t("executionStatus")}</dt>
      <dd>{statusT.has(node.status) ? statusT(node.status) : node.status}</dd>
      <dt>{t("attempt")}</dt>
      <dd>{node.attempt ?? "—"}</dd>
      {node.failure ? (
        <>
          <dt>{t("failure")}</dt>
          <dd>{node.failure}</dd>
        </>
      ) : null}
    </dl>
  );
}
