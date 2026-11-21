"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

export function ReportAutonomousReversal({
  runId,
  decisionId,
}: {
  runId: string;
  decisionId: string;
}) {
  const t = useTranslations("runAutonomy.reversal");
  const [state, setState] = useState<
    "idle" | "pending" | "verified" | "failed"
  >("idle");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state === "pending") return;
    const fields = new FormData(event.currentTarget);
    const revertSha = String(fields.get("revertSha") ?? "")
      .trim()
      .toLowerCase();

    setState("pending");
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/autonomous-decisions/${encodeURIComponent(decisionId)}/reverts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revertSha }),
        },
      );

      setState(response.ok ? "verified" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-medium">{t("report")}</summary>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(event) => void submit(event)}
      >
        <label className="flex flex-col gap-1">
          {t("commit")}
          <input
            required
            autoCapitalize="none"
            autoComplete="off"
            className="w-full rounded border border-line bg-paper px-2 py-1"
            disabled={state === "pending"}
            maxLength={64}
            name="revertSha"
            pattern="(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
            spellCheck={false}
          />
        </label>
        <button
          className="self-start rounded border border-line px-2 py-1"
          disabled={state === "pending"}
          type="submit"
        >
          {t("verify")}
        </button>
        {state === "failed" ? (
          <p role="alert">{t("failed")}</p>
        ) : state !== "idle" ? (
          <p role="status">{t(state)}</p>
        ) : null}
      </form>
    </details>
  );
}
