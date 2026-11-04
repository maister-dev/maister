import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  OperationalProbeContext,
  OperationalFailureDiagnostic,
} from "./operational-diagnostics";
import type { OperationalIntegrityBaseline } from "@/lib/run-results/operational-types";

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  tryAcquireMaterializationLock,
  releaseMaterializationLock,
} from "./materialization-lock";
import {
  claimAgentPreparation,
  renewAgentPreparation,
  advanceAgentPreparation,
  publishAgentPreparationBaseline,
  publishAgentPreparationGeneration,
  preparationFenced,
} from "./preparation-ownership";
import { assertSafeAgentMaterializationPath } from "./materialization-manifest";
import {
  withPreparationTrace,
  reportPreparationCleanupFailure,
} from "./preparation-trace";
import { operationalFailureDiagnostic } from "./operational-diagnostics";

import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { runtimeRoot } from "@/lib/runtime-root";
import { isFencedError } from "@/lib/execution-host/deliverer";
import { MaisterError } from "@/lib/errors";

export type PreparationWorkspaceFence = {
  run: <T>(effect: () => Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

type PreparationClaim = Awaited<ReturnType<typeof claimAgentPreparation>>;
export type AgentPreparationOwner = PreparationClaim & {
  runEffect: PreparationWorkspaceFence["run"];
  release: () => Promise<void>;
  assertHeld: () => void;
  isHeld: () => boolean;
  advance: (
    next: Parameters<typeof advanceAgentPreparation>[2],
  ) => Promise<void>;
  fail: (failure: OperationalFailureDiagnostic) => Promise<void>;
  publishBaseline: (baseline: OperationalIntegrityBaseline) => Promise<void>;
  publishGeneration: (
    baseline: OperationalIntegrityBaseline,
    previousGeneration: number,
  ) => Promise<void>;
};

/** Failure cleanup cannot change the primary owner's pending or fencing semantics. */
export async function releaseAgentPreparationAfterFailure(
  owner: Readonly<{ release: () => Promise<void> }> | null,
  primaryError: unknown,
  context: OperationalProbeContext,
): Promise<void> {
  if (!owner) return;
  try {
    await owner.release();
  } catch (cleanupError) {
    reportPreparationCleanupFailure({
      cleanupOperation: "preparation.release",
      primaryError,
      cleanupError,
      context,
    });
  }
}

/** Retain the first failure even when its journal write is unavailable. */
export async function recordAgentPreparationFailure(
  owner: AgentPreparationOwner | null,
  primaryError: unknown,
  context: OperationalProbeContext,
): Promise<void> {
  if (!owner) return;
  try {
    await owner.fail(operationalFailureDiagnostic(primaryError, context));
  } catch (cleanupError) {
    reportPreparationCleanupFailure({
      cleanupOperation: "preparation.publish_failure",
      primaryError,
      cleanupError,
      context,
    });
    if (isFencedError(cleanupError)) throw cleanupError;
  }
}

/** Repository fences retain registered orphan Git groups; plain trees spawn no Git. */
export async function acquirePreparationWorkspace(input: {
  repoPath: string;
  cwd: string;
  resourceKind: string;
}): Promise<PreparationWorkspaceFence> {
  if (input.resourceKind !== "plain_directory") {
    const fence = await acquireRepositoryMutationFence(input.repoPath);
    let released = false;

    return {
      run: fence.run,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await fence.release();
        } catch (error) {
          fence.retain();
          throw error;
        }
      },
    };
  }
  const key = createHash("sha256")
    .update(path.resolve(input.cwd))
    .digest("hex");
  const relative = `.maister/preparation-locks/${key}`;
  const root = await assertSafeAgentMaterializationPath(
    runtimeRoot(),
    relative,
  );
  const directory = path.join(root, relative);

  await mkdir(directory, { recursive: true });
  await assertSafeAgentMaterializationPath(root, relative);
  const handle = await tryAcquireMaterializationLock(directory);

  if (!handle)
    throw new MaisterError("CONFLICT", "Workspace preparation is active", {
      details: { reason: "operation_busy" },
    });

  return {
    run: (effect) => effect(),
    release: () => releaseMaterializationLock(handle),
  };
}

export async function openAgentPreparation(
  db: Db,
  input: {
    runId: string;
    assignmentId: string;
    repoPath: string;
    cwd: string;
    resourceKind: string;
  },
): Promise<AgentPreparationOwner> {
  const fence = await acquirePreparationWorkspace(input);

  try {
    const claim = await claimAgentPreparation(db, input);
    let renewalFailure: unknown;
    let renewing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing
        .then(() => renewAgentPreparation(db, claim.operation))
        .catch((error: unknown) => {
          renewalFailure = error;
        });
    }, 20_000);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await renewing;
      await fence.release();
    };

    return {
      ...claim,
      isHeld: () => !released,
      assertHeld: () => {
        if (released) throw preparationFenced(input.runId);
      },
      runEffect: (effect) =>
        withPreparationTrace(
          {
            runId: claim.operation.runId,
            assignmentId: claim.operation.assignmentId,
            assignmentEpoch: claim.operation.assignmentEpoch,
            preparationId: claim.operation.id,
          },
          () => fence.run(effect),
        ),
      release,
      fail: async (failure: OperationalFailureDiagnostic): Promise<void> => {
        if (!released)
          await advanceAgentPreparation(db, claim.operation, {
            phase: "failed",
            failure,
          });
      },
      advance: async (
        next: Parameters<typeof advanceAgentPreparation>[2],
      ): Promise<void> => {
        if (renewalFailure) throw renewalFailure;
        await advanceAgentPreparation(db, claim.operation, next);
      },
      publishBaseline: async (baseline): Promise<void> => {
        if (renewalFailure) throw renewalFailure;
        await publishAgentPreparationBaseline(db, claim.operation, baseline);
      },
      publishGeneration: async (
        baseline,
        previousGeneration,
      ): Promise<void> => {
        if (renewalFailure) throw renewalFailure;
        await publishAgentPreparationGeneration(
          db,
          claim.operation,
          baseline,
          previousGeneration,
        );
      },
    };
  } catch (error) {
    await releaseAgentPreparationAfterFailure(fence, error, {
      runId: input.runId,
      assignmentId: input.assignmentId,
      stage: "workspace_acquisition",
    });
    throw error;
  }
}
