import type { TryStartRunResult } from "@/lib/scheduler";

/** Keep a real allocated Run pending until a test explicitly drives its execution. */
export async function startAllocatedRun(): Promise<TryStartRunResult> {
  return { started: false, queuePosition: 1 };
}
