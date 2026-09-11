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

/**
 * The canonical SSE cursor spelling: a non-negative decimal with no leading
 * zero, bounded to 19 digits so it cannot outrun a 64-bit id.
 *
 * It lives here because THREE places have to agree on it — the route that
 * parses `Last-Event-ID`, the client that decides whether a received id is
 * usable, and `attention-stream.asyncapi.yaml`'s `pattern`, which
 * `validate-contracts` checks. The client's own copy used to reject `0`, which
 * the route accepts; one constant is how that stops happening.
 *
 * A fresh `RegExp` per call, never a shared instance: a shared literal with no
 * `g` flag is safe today, but a future `g` would carry `lastIndex` between
 * unrelated callers.
 */
export const SSE_CURSOR_PATTERN_SOURCE = "^(0|[1-9][0-9]{0,18})$";

export function isSseCursor(raw: string): boolean {
  return new RegExp(SSE_CURSOR_PATTERN_SOURCE).test(raw);
}

export const SSE_STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // Without this nginx buffers the whole stream and the reader sees nothing
  // until the connection closes.
  "X-Accel-Buffering": "no",
} as const;
