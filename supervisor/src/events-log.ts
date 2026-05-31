import type { Logger } from "pino";

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { type SessionEvent } from "./types";

export type EventsLogWriter = {
  append(event: SessionEvent): void;
  close(): Promise<void>;
  bytesWritten(): number;
  path(): string;
};

export type OpenEventsLogOptions = {
  logger?: Logger;
};

export async function openEventsLog(
  path: string,
  opts: OpenEventsLogOptions = {},
): Promise<EventsLogWriter> {
  const log = opts.logger?.child({ name: "supervisor-events-log" });

  await mkdir(dirname(path), { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  let bytes = 0;
  let closed = false;
  let closing: Promise<void> | null = null;

  stream.on("error", (err) => {
    log?.error({ path, err: err.message }, "events-log stream error");
  });

  return {
    append(event: SessionEvent): void {
      if (closed) return;

      const line = `${JSON.stringify(event)}\n`;
      const ok = stream.write(line);

      bytes += Buffer.byteLength(line);
      log?.debug(
        {
          path,
          monotonicId: event.monotonicId,
          type: event.type,
          bytes: line.length,
        },
        "events-log append",
      );
      if (!ok) {
        log?.warn({ path, bytes }, "events-log backpressure");
      }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = new Promise<void>((res) => {
        stream.end(() => {
          res();
        });
      });

      return closing;
    },
    bytesWritten(): number {
      return bytes;
    },
    path(): string {
      return path;
    },
  };
}
