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
