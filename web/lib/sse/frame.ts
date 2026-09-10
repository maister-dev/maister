/**
 * SSE wire formatting, shared by the routes that speak it (ADR-170).
 *
 * Three routes now stream: one run, one evaluation study, and the user-scoped
 * attention stream. They disagree about WHAT they send and agree completely
 * about how a frame is spelled, so the spelling lives here — a fourth route
 * copying `id:\nevent:\ndata:\n\n` by hand is how a stray newline ships.
 */

export interface SseFrame {
  /** Becomes `Last-Event-ID` on reconnect. Omit for a frame that must not move it. */
  id?: string | number | null;
  event?: string | null;
  data: unknown;
}

export function sseFrame({ id, event, data }: SseFrame): string {
  const lines: string[] = [];

  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);

  return `${lines.join("\n")}\n\n`;
}

export const SSE_STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // Without this nginx buffers the whole stream and the reader sees nothing
  // until the connection closes.
  "X-Accel-Buffering": "no",
} as const;
