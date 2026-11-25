"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { useCoalescedRefresh } from "@/lib/runs/use-coalesced-refresh";
import { useRunStream } from "@/lib/use-run-stream";

const ASSIGNMENT_REFRESH_COALESCE_MS = 750;

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
  const scope = `${assignmentId}:${runId ?? ""}`;
  const [trackedScope, setTrackedScope] = useState(scope);

  if (trackedScope !== scope) {
    setTrackedScope(scope);
    setUnavailable(false);
  }
  const revisionRef = useRef(revision);

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  const triggerRefresh = useCoalescedRefresh(
    async (signal) => {
      try {
        const response = await fetch(
          `/api/specialist-assignments/${encodeURIComponent(assignmentId)}`,
          { signal },
        );

        if (signal.aborted) return;
        if (!response.ok) {
          setUnavailable(true);

          return;
        }
        const value: unknown = await response.json();

        if (signal.aborted) return;
        setUnavailable(false);
        if (
          value &&
          typeof value === "object" &&
          "revision" in value &&
          value.revision !== revisionRef.current
        )
          router.refresh();
      } catch {
        if (signal.aborted) return;
        setUnavailable(true);
      }
    },
    ASSIGNMENT_REFRESH_COALESCE_MS,
    runId ? `${assignmentId}:${runId}` : null,
  );

  useEffect(() => {
    if (!runId || liveness !== "live") return;

    triggerRefresh();
  }, [assignmentId, eventCount, liveness, runId, triggerRefresh]);

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
