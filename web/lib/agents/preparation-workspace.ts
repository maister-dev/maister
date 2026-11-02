import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { OperationalFailureDiagnostic } from "./operational-diagnostics";

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
} from "./preparation-ownership";
import { assertSafeAgentMaterializationPath } from "./materialization-manifest";
import { withPreparationTrace } from "./preparation-trace";

import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { runtimeRoot } from "@/lib/runtime-root";
import { MaisterError } from "@/lib/errors";

export type PreparationWorkspaceFence = {
  run: <T>(effect: () => Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

type PreparationClaim = Awaited<ReturnType<typeof claimAgentPreparation>>;
export type AgentPreparationOwner = PreparationClaim & {
  runEffect: PreparationWorkspaceFence["run"];
  release: () => Promise<void>;
  advance: (
    next: Parameters<typeof advanceAgentPreparation>[2],
  ) => Promise<void>;
  fail: (failure: OperationalFailureDiagnostic) => Promise<void>;
};

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
    };
  } catch (error) {
    await fence.release();
    throw error;
  }
}
