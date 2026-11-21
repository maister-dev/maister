import { useFormatter, useTranslations } from "next-intl";
import type { ReactElement } from "react";

import type { WorkspaceIntegrityLimit } from "@/lib/agents/operational-diagnostics";
import {
  workspaceIntegrityFields,
  type IntegrityField,
} from "@/lib/workspace-integrity/settings-schema";

const fields: Record<
  WorkspaceIntegrityLimit["limitAxis"],
  IntegrityField | null
> = {
  bytes: "maxSizeMiB",
  entries: "maxEntries",
  time: "maxDurationSeconds",
  worktree_config_bytes: null,
};

export function WorkspaceIntegrityNotice({
  limit,
  runId,
  isGlobalAdmin,
}: {
  limit: WorkspaceIntegrityLimit;
  runId: string;
  isGlobalAdmin: boolean;
}): ReactElement {
  const t = useTranslations("workspaceIntegrity");
  const format = useFormatter();
  const field = fields[limit.limitAxis];
  const consequence =
    limit.stage === "final_verification"
      ? "indeterminate"
      : limit.stage === "cleanup" || limit.stage === "evidence_capture"
        ? "cleanupBlocked"
        : "preparationBlocked";

  return (
    <div
      data-testid="workspace-integrity-refusal"
      role="status"
      className="my-3 rounded-lg border border-line p-3"
    >
      <p className="font-medium">
        {t("stopped", {
          stage: t(`stages.${limit.stage}`),
          resource: t(`resources.${limit.resource}`),
        })}
      </p>
      <p>
        {t(`observations.${limit.limitAxis}`, {
          observed: format.number(
            limit.observed / (limit.unit === "ms" ? 1000 : 1),
          ),
          maximum: format.number(
            limit.maximum /
              (limit.limitAxis === "bytes"
                ? 1048576
                : limit.unit === "ms"
                  ? 1000
                  : 1),
          ),
        })}
      </p>
      <p>{t(consequence)}</p>
      <p>{t(`remediation.${limit.limitAxis}`)}</p>
      {field &&
        (isGlobalAdmin ? (
          <a
            className="underline"
            href={`/settings#${workspaceIntegrityFields[field].anchor}`}
          >
            {t("openSetting", { field: t(`fields.${field}`) })}
          </a>
        ) : (
          <p>{t("askAdmin", { field: t(`fields.${field}`), runId })}</p>
        ))}
      <details className="mt-2">
        <summary>{t("details")}</summary>
        <p>
          {t("measurements", {
            observed: format.number(limit.observed),
            maximum: format.number(limit.maximum),
            unit: t(`units.${limit.unit}`),
            bytes: format.number(limit.observedBytes),
            entries: format.number(limit.observedEntries),
            elapsed: format.number(limit.elapsedMs),
          })}
        </p>
        <code>{limit.reason}</code>
      </details>
    </div>
  );
}
