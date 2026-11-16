"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { useRunStream } from "@/lib/use-run-stream";

export function AssignmentLiveRefresh({
  assignmentId,
  revision,
  runId,
}: {
  assignmentId: string;
  revision: number;
  runId: string | null;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const router = useRouter();
  const { eventCount, liveness } = useRunStream(runId, { retain: false });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!runId || liveness !== "live") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/specialist-assignments/${encodeURIComponent(assignmentId)}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          setUnavailable(true);

          return;
        }
        const value: unknown = await response.json();

        if (controller.signal.aborted) return;
        setUnavailable(false);
        if (
          value &&
          typeof value === "object" &&
          "revision" in value &&
          value.revision !== revision
        )
          router.refresh();
      } catch {
        if (controller.signal.aborted) return;
        setUnavailable(true);
      }
    }, 750);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [assignmentId, revision, runId, router, eventCount, liveness]);

  return (
    <div className="flex items-center gap-2">
      {unavailable ? (
        <p className="text-xs text-mute" role="status">
          {t("progressUnavailable")}
        </p>
      ) : null}
      <Button size="sm" variant="secondary" onPress={() => router.refresh()}>
        {t("refresh")}
      </Button>
    </div>
  );
}
