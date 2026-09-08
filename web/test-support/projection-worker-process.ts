import { closeDb } from "@/lib/db/client";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

// Uses the same activation and complete registry as web instrumentation.
startCanonicalProjectionWorker();
process.send?.({ state: "ready" });
process.once("SIGTERM", () => {
  void stopCanonicalProjectionWorker()
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
