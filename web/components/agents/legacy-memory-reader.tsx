"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";

import { vaultRequest } from "./agent-memory-requests";

export function LegacyMemoryReader({ endpoint }: { endpoint: string }) {
  const t = useTranslations("knowledge");
  const [body, setBody] = useState<string | null>(null);
  const [state, setState] = useState<"ready" | "busy" | "failed">("ready");

  async function read() {
    setState("busy");
    try {
      const record = await vaultRequest<{ content: string | null }>(endpoint);

      setBody(record.content ?? "");
      setState("ready");
    } catch {
      setBody(null);
      setState("failed");
    }
  }

  return (
    <div className="space-y-3">
      <Button
        isPending={state === "busy"}
        size="sm"
        variant="secondary"
        onPress={() => void read()}
      >
        {t("legacyRead")}
      </Button>
      {state === "failed" ? <p role="alert">{t("vaultReadFailed")}</p> : null}
      {body === "" ? (
        <p role="status">{t("vaultState.empty")}</p>
      ) : body !== null ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-canvas p-4">
          {body}
        </pre>
      ) : null}
    </div>
  );
}
