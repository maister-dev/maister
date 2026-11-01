"use client";

import type { ReactNode } from "react";
import type { WorkbenchStream } from "@/lib/use-run-workbench-stream";

import { createContext, useContext } from "react";

import { RunStreamValueProvider } from "@/components/runs/run-stream-provider";
import { useRunWorkbenchStream } from "@/lib/use-run-workbench-stream";

const WorkbenchStreamContext = createContext<WorkbenchStream | null>(null);

export function useWorkbenchStream(): WorkbenchStream | null {
  return useContext(WorkbenchStreamContext);
}
export function RunWorkbenchStreamProvider({
  anchorRunId,
  selectedRunId,
  children,
}: {
  anchorRunId: string;
  selectedRunId: string | null;
  children: ReactNode;
}): ReactNode {
  const stream = useRunWorkbenchStream(anchorRunId, selectedRunId);

  return (
    <WorkbenchStreamContext.Provider value={stream}>
      <RunStreamValueProvider runId={anchorRunId} stream={stream.main}>
        {children}
      </RunStreamValueProvider>
    </WorkbenchStreamContext.Provider>
  );
}
