import type { Response } from "@playwright/test";

type LaunchFrame = {
  type: string;
  result?: unknown;
  code?: string;
  message?: string;
};

export type LaunchStreamResult = {
  runId: string;
  status: string;
  queuePosition?: number;
};

// `POST /api/runs` content-negotiates (app/api/runs/route.ts): a client sending
// `Accept: text/event-stream` — which the board's launch dialog does, to drive
// its staged progress labels — gets 200 plus a progress stream terminated by a
// `scratch.launch_result` frame. The JSON `202 {runId,...}` shape is the
// NON-stream path only, so a browser-driven launch must be read from here.
export async function readLaunchResult(
  response: Response,
): Promise<LaunchStreamResult> {
  const frames = (await response.text())
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as LaunchFrame);
  const terminal = frames.at(-1);

  if (terminal?.type === "error") {
    throw new Error(`launch failed: ${terminal.code} — ${terminal.message}`);
  }

  if (terminal?.type !== "scratch.launch_result") {
    throw new Error(
      `launch stream ended without a result frame (last: ${JSON.stringify(terminal)})`,
    );
  }

  return terminal.result as LaunchStreamResult;
}
