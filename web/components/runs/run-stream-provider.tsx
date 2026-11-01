"use client";

import type { ReactNode } from "react";
import type { UseRunStreamResult } from "@/lib/use-run-stream";

import { createContext, useContext } from "react";

import { isLiveRunStatus } from "@/lib/runs/live-inspector";
import { useRunStream } from "@/lib/use-run-stream";

type RunStreamContextValue = {
  runId: string;
  stream: UseRunStreamResult;
};

const RunStreamContext = createContext<RunStreamContextValue | null>(null);

export function RunStreamProvider({
  children,
  runId,
  runStatus,
}: {
  children: ReactNode;
  runId: string;
  runStatus: string;
}): ReactNode {
  const stream = useRunStream(isLiveRunStatus(runStatus) ? runId : null, {
    retain: false,
  });

  return (
    <RunStreamValueProvider runId={runId} stream={stream}>
      {children}
    </RunStreamValueProvider>
  );
}

export function RunStreamValueProvider({
  runId,
  stream,
  children,
}: {
  runId: string;
  stream: UseRunStreamResult;
  children: ReactNode;
}): ReactNode {
  return (
    <RunStreamContext.Provider value={{ runId, stream }}>
      {children}
    </RunStreamContext.Provider>
  );
}

export function useRunPageStream(
  runId: string,
  live: boolean,
): UseRunStreamResult {
  const context = useContext(RunStreamContext);
  const fallback = useRunStream(
    context?.runId === runId ? null : live ? runId : null,
    {
      retain: false,
    },
  );

  if (context?.runId === runId) return context.stream;

  return fallback;
}
