import type { SessionEvent } from "../../types";

// A `GET /sessions/:id/stream` reader for tests that drive a SPAWNED
// supervisor: the in-process suites subscribe to the registry emitter
// directly, which a child process has no emitter for.
export type SseCollector = {
  events: SessionEvent[];
  // Resolves with the first event matching `predicate` — including one already
  // collected, so a caller that starts waiting after the event arrived is not
  // stranded.
  waitFor(
    predicate: (event: SessionEvent) => boolean,
    timeoutMs?: number,
  ): Promise<SessionEvent>;
  close(): Promise<void>;
};

export async function collectSessionEvents(
  url: string,
  sessionId: string,
): Promise<SseCollector> {
  const controller = new AbortController();
  const res = await fetch(`${url}/sessions/${sessionId}/stream`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }

  const events: SessionEvent[] = [];
  const waiters: Array<{
    predicate: (event: SessionEvent) => boolean;
    resolve: (event: SessionEvent) => void;
  }> = [];
  const push = (event: SessionEvent): void => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(event)) {
        waiters[i].resolve(event);
        waiters.splice(i, 1);
      }
    }
  };

  const pump = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");

      while (split !== -1) {
        const frame = buffer.slice(0, split);

        buffer = buffer.slice(split + 2);
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));

        if (dataLine) push(JSON.parse(dataLine.slice(6)) as SessionEvent);
        split = buffer.indexOf("\n\n");
      }
    }
  })().catch(() => undefined);

  return {
    events,
    waitFor(predicate, timeoutMs = 20_000) {
      const already = events.find(predicate);

      if (already) return Promise.resolve(already);

      return new Promise<SessionEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no matching session event within ${timeoutMs}ms; saw: ${events
                .map((e) => e.type)
                .join(", ")}`,
            ),
          );
        }, timeoutMs);

        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}
