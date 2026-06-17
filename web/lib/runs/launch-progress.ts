// FR-F1/F2: staged launch progress for the streaming-POST launch (Option 2,
// sub-plan 2026-06-17). These frames travel on the launch request's OWN
// `text/event-stream` response — NOT the run SSE — so they carry no `id:`
// line (they are not durable run.events.jsonl entries), mirroring the
// run-stream's synthetic timeout event.

export type LaunchStage =
  | "precondition"
  | "worktree_created"
  | "materializing"
  | "spawning"
  | "session_ready";

export const LAUNCH_STAGES: readonly LaunchStage[] = [
  "precondition",
  "worktree_created",
  "materializing",
  "spawning",
  "session_ready",
];

export type LaunchProgressEvent = {
  type: "scratch.launch_progress";
  stage: LaunchStage;
  adapter?: string;
};

export function launchProgress(
  stage: LaunchStage,
  adapter?: string,
): LaunchProgressEvent {
  return adapter
    ? { type: "scratch.launch_progress", stage, adapter }
    : { type: "scratch.launch_progress", stage };
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function formatLaunchProgressFrame(ev: LaunchProgressEvent): string {
  return sseData(ev);
}

export function formatLaunchResultFrame(result: unknown): string {
  return sseData({ type: "scratch.launch_result", result });
}

export function formatLaunchErrorFrame(code: string, message: string): string {
  return sseData({ type: "error", code, message });
}

export type LaunchStreamApiError = { code?: string; message?: string };

// Client-side reader for the launch POST's `text/event-stream` response: drives
// `onStage` per progress frame and returns the terminal result/error frame.
// Generic over the result payload (scratch `ScratchRunResponse` / flow
// `{runId,status,queuePosition?}`).
export async function readLaunchStream<T>(
  response: Response,
  onStage: (stage: LaunchStage) => void,
): Promise<{ result?: T; error?: LaunchStreamApiError }> {
  const reader = response.body?.getReader();

  if (!reader) return {};
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  let error: LaunchStreamApiError | undefined;

  for (;;) {
    const { done, value } = await reader.read();

    if (value) buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const block = buffer.slice(0, boundary).trim();

      buffer = buffer.slice(boundary + 2);
      if (block.startsWith("data:")) {
        let frame:
          | {
              type?: string;
              stage?: LaunchStage;
              result?: T;
              code?: string;
              message?: string;
            }
          | undefined;

        try {
          frame = JSON.parse(block.slice(block.indexOf("data:") + 5).trim());
        } catch {
          // Skip a malformed/partial frame and keep reading the stream rather
          // than aborting the whole launch read on one bad line.
          frame = undefined;
        }

        if (frame?.type === "scratch.launch_progress" && frame.stage) {
          onStage(frame.stage);
        } else if (frame?.type === "scratch.launch_result") {
          result = frame.result;
        } else if (frame?.type === "error") {
          error = { code: frame.code, message: frame.message };
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }

  return { result, error };
}
