// ADR-167 D5 amendment (2026-09-23), D-B8 drift guard. A fast evidence feed
// settles a turn only when its span holds none of the event types the flow
// runner's live consumer reacts to, because under ingest lag that consumer has
// not seen them yet. If `startEventConsumer` starts reacting to a new type, a
// fast settlement could advance a node past a signal the runner never
// observed — so every type it branches on must be in the shared list.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONSUMER_SIGNAL_EVENT_TYPES } from "@/lib/execution-host/prompt-signal-events";

// Text capture only. `session.update` also clears a pending permission, which
// exists only after a `session.permission_request` in the same span.
const TEXT_ONLY_EVENT_TYPES = ["session.update", "session.line"];

function consumerBody(): string {
  const source = readFileSync(
    path.resolve("lib/flows/runner-agent.ts"),
    "utf8",
  );
  const start = source.indexOf("function startEventConsumer(");

  expect(start).toBeGreaterThan(-1);

  return source.slice(start, source.indexOf("\n}\n", start));
}

describe("flow consumer signal event types", () => {
  it("names every event type the flow consumer reacts to", () => {
    const handled = new Set(
      [...consumerBody().matchAll(/ev\.type === "([a-z_.]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const signals = [...handled].filter(
      (type) => !TEXT_ONLY_EVENT_TYPES.includes(type),
    );

    expect(signals.sort()).toEqual([...CONSUMER_SIGNAL_EVENT_TYPES].sort());
  });
});
