import type {
  AcpCompactionStatus,
  ContextUsage,
} from "../../../runtime/acp-context";
import { decodeAcpContextUpdate } from "../../../runtime/acp-context";

export type CompactionMarker = {
  v: 1;
  kind: "compaction";
  status: AcpCompactionStatus | "interrupted";
  summary?: string;
  error?: string;
  before?: ContextUsage;
  after?: ContextUsage;
};

export function parseCompactionMarker(value: unknown): CompactionMarker | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "compaction" ||
    !("v" in value) ||
    value.v !== 1 ||
    !("status" in value)
  )
    return null;
  const { status } = value;

  if (
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  )
    return null;

  return {
    v: 1,
    kind: "compaction",
    status,
    ...readMeasurement(value, "before"),
    ...readMeasurement(value, "after"),
    ...("summary" in value && typeof value.summary === "string"
      ? { summary: value.summary }
      : {}),
    ...("error" in value && typeof value.error === "string"
      ? { error: value.error }
      : {}),
  };
}

function readMeasurement(value: object, field: "before" | "after") {
  const raw = (value as Partial<Record<typeof field, unknown>>)[field];

  if (raw === null || typeof raw !== "object") return {};
  const observation = decodeAcpContextUpdate({ ...raw, sessionUpdate: "usage_update" });

  return observation?.kind === "usage"
    ? { [field]: { used: observation.used, size: observation.size } }
    : {};
}
