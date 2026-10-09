import { getContainerRuntimeClient } from "testcontainers";

import { retainLaneReaper } from "../lane-reaper.ts";

if (!process.send) throw new Error("reaper acquisition control requires IPC");
const owner = new AbortController();
const release = new Promise((resolve) => {
  process.on("message", (message) => {
    if (message === "abort")
      owner.abort(new Error("owning runner interrupted"));
    else if (message === "release") resolve();
    else throw new Error("unexpected reaper acquisition control command");
  });
});
const startedAt = Date.now();

try {
  await retainLaneReaper(owner.signal);
  process.send({
    event: "outcome",
    outcome: "unexpected-success",
    durationMs: Date.now() - startedAt,
  });
} catch (error) {
  process.send({
    event: "outcome",
    outcome: "rejected",
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - startedAt,
  });
}
// Complete real, previously held Docker discovery after the public helper
// rejected. The parent checks that this never starts a late reaper lookup.
await getContainerRuntimeClient();
process.send({ event: "client-settled" });
await release;
process.disconnect();
