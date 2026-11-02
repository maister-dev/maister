import type {
  AgentRetryOptions,
  RetryRunnerOption,
} from "@/lib/agents/retry-preparation";
import type { AgentRetryReceipt } from "@/lib/agents/retry";

export type AgentRetryBatchItem = {
  runId: string;
  taskId: string | null;
  title: string;
  options: AgentRetryOptions | null;
  reason: string | null;
};

export type AgentRetryBatchOptions = {
  items: AgentRetryBatchItem[];
  runners: RetryRunnerOption[];
  selectedRunnerId: string | null;
  totalFailed: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type AgentRetryBatchRequest = {
  runnerId: string;
  items: Array<{
    runId: string;
    requestKey: string;
    previewFingerprint: string;
    strategy: "pre_work_retry" | "fresh_qualification";
  }>;
};

export type AgentRetryBatchResultItem = {
  runId: string;
  receipt: AgentRetryReceipt | null;
  reason: string | null;
  state: "accepted" | "refused" | "unknown";
};

export type AgentRetryBatchResult = {
  items: AgentRetryBatchResultItem[];
};
