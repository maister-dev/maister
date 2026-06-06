"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";

import { RunHitlResponse } from "@/components/board/run-hitl-response";

interface FlightCardHitlProps {
  runId: string;
  hitlRequestId: string;
  kind: "permission" | "form" | "human";
  options: HitlOption[];
  schema: unknown;
  criticality?: "low" | "medium" | "high" | "critical" | null;
}

export function FlightCardHitl({
  runId,
  hitlRequestId,
  kind,
  options,
  schema,
  criticality,
}: FlightCardHitlProps): ReactElement {
  const router = useRouter();

  return (
    <RunHitlResponse
      canAct
      compact
      criticality={criticality}
      hitlRequestId={hitlRequestId}
      kind={kind}
      options={options}
      runId={runId}
      schema={schema}
      onRespond={() => router.refresh()}
    />
  );
}
