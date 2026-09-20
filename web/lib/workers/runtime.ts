import "server-only";

import type { PromptOwnerRegistry } from "@/lib/execution-host/prompt-owners";

import {
  durableWorkersHealth,
  readDurableWorkerSlot,
  writeDurableWorkerSlot,
  type DurableWorkerHandle,
  type DurableWorkerName,
} from "./health";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { PROMPT_OWNER_SHAPES } from "@/lib/execution-host/prompt-owner-contract";
import { createPromptOwnerRegistry } from "@/lib/execution-host/prompt-owners";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { consensusDraftPromptOwners } from "@/lib/flows/graph/consensus/draft-prompt-owner";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { scratchPromptOwners } from "@/lib/scratch-runs/prompt-owner";
import { syncPromptOwners } from "@/lib/runs/sync-prompt-owner";
import { gateChatPromptOwners } from "@/lib/services/gate-chat-prompt-owner";
import { isApplicationStopping } from "@/lib/server-lifecycle";

// The composition root for the three durable workers, reached ONLY from
// `instrumentation-node.ts` through a dynamic `await import()`. It must not
// live under `lib/execution-host/`: every domain registry below imports that
// package, so a registry module inside it closes a cycle at module load — and
// a cycle there fails mocked suites as SKIPS rather than as errors.
//
// `health.ts` is imported from here and never imports back, which is what keeps
// the health surface free of this file's domain graph.

/**
 * The five production owner registries, one per `PromptOwnerSchema` kind.
 *
 * `agent_turn` is served by `consensusDraftPromptOwners`, NOT by
 * `agentPromptOwners`: the draft registry routes a `consensus_draft` variant to
 * draft preparation and every other variant to the ordinary agent owner, while
 * `agentPromptOwners` refuses `consensus_draft` outright. Listing both is a
 * `CONFIG` boot failure by design, and the duplicate-kind check below is what
 * makes that failure loud.
 */
export const PRODUCTION_PROMPT_OWNER_REGISTRIES = [
  flowPromptOwners,
  consensusDraftPromptOwners,
  scratchPromptOwners,
  syncPromptOwners,
  gateChatPromptOwners,
] as const;

const EXPECTED_OWNER_KINDS = new Set(
  PROMPT_OWNER_SHAPES.map((shape) => shape.kind),
);

/**
 * Merges the registries and asserts the composed key set against the schema's
 * own shapes. The database CHECK derives from `PROMPT_OWNER_SHAPES` too, so
 * registry, schema and constraint cannot drift apart silently.
 */
export function composePromptOwnerRegistry(
  registries: readonly PromptOwnerRegistry[],
): PromptOwnerRegistry {
  const adapters = registries.flatMap((registry) => [...registry.values()]);
  // Throws CONFIG on a duplicate kind — the `agentPromptOwners` case above.
  const composed = createPromptOwnerRegistry(adapters);
  const missing = [...EXPECTED_OWNER_KINDS].filter(
    (kind) => !composed.has(kind as never),
  );
  const unexpected = [...composed.keys()].filter(
    (kind) => !EXPECTED_OWNER_KINDS.has(kind),
  );

  if (missing.length > 0 || unexpected.length > 0)
    throw new MaisterError(
      "CONFIG",
      `prompt owner registry and PROMPT_OWNER_SHAPES disagree (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );

  return composed;
}

export type DurableWorkers = Readonly<
  Record<DurableWorkerName, DurableWorkerHandle>
>;

function slotted(
  name: DurableWorkerName,
  start: () => DurableWorkerHandle,
): DurableWorkerHandle {
  const existing = readDurableWorkerSlot(name);

  if (existing) return existing;
  const handle = start();

  writeDurableWorkerSlot(name, handle);

  return handle;
}

/**
 * Starts the prompt-owner recovery worker and the two continuation workers,
 * once per process. No environment variable gates any of them: a half-activated
 * owner is the state the deployment gate existed to prevent, so activation is
 * all-or-nothing.
 */
export function startDurableWorkers(): DurableWorkers {
  if (isApplicationStopping())
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "durable workers are shutting down",
    );
  const db = getDb();
  // Compose BEFORE starting: `startPromptOwnerWorker` refuses an empty
  // registry, and a start ordered before the registry resolves would fail into
  // the boot try/catch and leave the worker silently unstarted.
  const owners = composePromptOwnerRegistry(PRODUCTION_PROMPT_OWNER_REGISTRIES);

  return {
    // The prompt-owner worker already logs its own start/stop with ownerKinds
    // and concurrency; do not duplicate that here.
    promptOwner: slotted("promptOwner", () =>
      startPromptOwnerWorker({ db, owners }),
    ),
    flowContinuation: slotted("flowContinuation", () =>
      startFlowContinuationWorker({ db }),
    ),
    agentContinuation: slotted("agentContinuation", () =>
      startAgentContinuationWorker({ db }),
    ),
  };
}

/** Stops every worker this process still owns, clearing only its own slots. */
export async function stopDurableWorkers(): Promise<void> {
  const names: DurableWorkerName[] = [
    "promptOwner",
    "flowContinuation",
    "agentContinuation",
  ];
  const stopped = await Promise.allSettled(
    names.map(async (name) => {
      const handle = readDurableWorkerSlot(name);

      if (!handle) return;
      try {
        await handle.stop();
      } finally {
        if (readDurableWorkerSlot(name) === handle)
          writeDurableWorkerSlot(name, undefined);
      }
    }),
  );
  const failures = stopped.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  // A claim release the worker could not confirm must FAIL shutdown and leave
  // the durable claim to expire — never be dropped as if released.
  if (failures.length > 0)
    throw new AggregateError(failures, "durable workers could not stop");
}

export { durableWorkersHealth };
