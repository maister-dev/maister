import type { FlowManifestIncompatibility } from "@/lib/flows/manifest-parser";
import type { RunKind } from "@/lib/db/schema";
import type { RunPublicResultDto } from "@/lib/runs/run-result-dto";
import type { ResultStatus } from "@/lib/run-results/types";

export interface RunPeekSummary {
  runId: string;
  label: string;
  runKind: RunKind;
  taskRef: string | null;
  status: string;
  resultStatus: ResultStatus | null;
  launchedAt: string | null;
  startedAt: string | null;
  hasChildren: boolean;
  fullRunHref: string;
}

export interface RunPeekChildPage {
  anchorRunId: string;
  parentRunId: string;
  items: RunPeekSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

export interface RunPeekNode {
  id: string;
  label: string;
  type: string;
  status: string;
  attempt: number | null;
  failure: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type RunPeekContent =
  | {
      kind: "conversation" | "operational";
      availability: "ready" | "forbidden";
    }
  | {
      kind: "flow";
      availability: "ready" | "incompatible";
      compatible: boolean;
      incompatibility: FlowManifestIncompatibility | null;
      nodes: RunPeekNode[];
      selectedNodeId: string | null;
    };

export interface RunPeekSnapshot {
  anchorRunId: string;
  selectedRunId: string;
  breadcrumbs: RunPeekSummary[];
  summary: RunPeekSummary;
  capabilities: { canReadTranscript: boolean; canReadEvidence: boolean };
  workspace: "none" | "present" | "removed";
  content: RunPeekContent;
  publicResult: RunPublicResultDto | null;
  fullRunHref: string;
}
