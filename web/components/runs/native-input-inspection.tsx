import type { ReactElement } from "react";
import type { NativeInputInspection } from "@/lib/orchestrator/native-input-read";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function NativeInputInspectionPanel({
  input,
}: {
  input: NativeInputInspection;
}): Promise<ReactElement> {
  const t = await getTranslations("run.originalInput");

  if ("kind" in input) {
    const retained = input.input;
    const snapshot = retained.snapshot;
    const sections = [
      ["objectiveSnapshot", snapshot.objectiveInput],
      ["standingSnapshot", snapshot.standingDefinition],
      ["scheduledSnapshot", snapshot.scheduledRequest],
      ["authoritySnapshot", snapshot.authoritySnapshot],
    ] as const;

    return (
      <details
        className="my-2 rounded-lg border border-line p-2"
        data-testid="assignment-input-inspection"
      >
        <summary className="text-sm">{t("assignmentTitle")}</summary>
        <p className="mt-2 text-sm font-medium">
          {snapshot.objectiveInput.objective}
        </p>
        <p className="mt-2 text-sm">
          {snapshot.objectiveInput.expectedOutcome}
        </p>
        <p className="mt-2 break-all text-xs">
          {t("assignment")}: <code>{retained.assignmentId}</code>
        </p>
        <p className="mt-1 text-xs">
          {t("revision")}: {retained.revision}
        </p>
        <p className="mt-1 break-all text-xs text-mute">
          {t("witness")}: <code>{retained.digest}</code>
        </p>
        {sections.map(([label, value]) => (
          <details key={label} className="mt-3 rounded border border-line p-2">
            <summary className="text-sm">{t(label)}</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs">
              {value === null
                ? t("notScheduled")
                : JSON.stringify(value, null, 2)}
            </pre>
          </details>
        ))}
      </details>
    );
  }

  return (
    <details
      className="my-2 rounded-lg border border-line p-2"
      data-testid="native-input-inspection"
    >
      <summary className="text-sm">{t("title")}</summary>
      <p className="mt-2 text-sm font-medium">{input.title}</p>
      <pre className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm">
        {input.prompt}
      </pre>
      <p className="mt-2 text-xs">
        <Link
          className="underline"
          href={`/runs/${encodeURIComponent(input.sourceRunId)}`}
        >
          {t("origin")}
        </Link>
      </p>
      <p className="mt-1 break-all text-xs text-mute">
        {t("witness")}: <code>{input.inputDigest}</code>
      </p>
    </details>
  );
}
