import fs from "node:fs/promises";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

import { z } from "zod";

import { getDb, closeDb } from "@/lib/db/client";
import {
  acquirePreparationWorkspace,
  openAgentPreparation,
} from "@/lib/agents/preparation-workspace";
import { captureOperationalBaseline } from "@/lib/agents/operational-integrity";
import { operationalFailureDiagnostic } from "@/lib/agents/operational-diagnostics";
import {
  addDetachedWorktree,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";
import { isMaisterError } from "@/lib/errors";

const action = z
  .enum(["capture", "owned-remove", "unfenced-remove"])
  .parse(process.argv[2]);
const input = z
  .object({
    runId: z.string(),
    assignmentId: z.string(),
    repoPath: z.string(),
    cwd: z.string(),
    source: z.string(),
  })
  .strict()
  .parse(JSON.parse(process.argv[3] ?? "null") as unknown);
const resource = {
  repoPath: input.repoPath,
  cwd: input.cwd,
  resourceKind: "ephemeral_checkout",
};

async function send(message: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Preparation fixture requires IPC"));

      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function capture(): Promise<number> {
  const owner = await openAgentPreparation(getDb(), {
    ...resource,
    runId: input.runId,
    assignmentId: input.assignmentId,
  });
  const target = path.join(input.cwd, input.source);
  const lstat = fs.lstat;
  let entered = false;

  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    if (!entered && String(args[0]) === target) {
      entered = true;
      const controller = new AbortController();
      const disconnect = (): void => controller.abort();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      process.once("disconnect", disconnect);
      try {
        const resumed = once(process, "message", {
          signal: controller.signal,
        });

        await send({ type: "probe-paused" });
        await resumed;
      } finally {
        clearTimeout(timeout);
        process.off("disconnect", disconnect);
      }
    }

    return lstat(...args);
  }) as typeof fs.lstat;
  syncBuiltinESMExports();
  try {
    return await owner.runEffect(async () => {
      const commit = await resolveBaseCommit({
        projectRepoPath: input.repoPath,
        baseRef: "main",
      });

      await owner.advance({ phase: "claimed", resolvedCommit: commit });
      await addDetachedWorktree({
        projectRepoPath: input.repoPath,
        worktreePath: input.cwd,
        committish: commit,
      });
      await owner.advance({ phase: "checkout_ready" });
      const baseline = await captureOperationalBaseline(
        input.cwd,
        "ephemeral_checkout",
        {
          context: {
            runId: input.runId,
            assignmentId: input.assignmentId,
            assignmentEpoch: owner.operation.assignmentEpoch,
            preparationId: owner.operation.id,
            stage: "baseline",
          },
        },
      );

      return baseline.source.length;
    });
  } finally {
    fs.lstat = lstat;
    syncBuiltinESMExports();
    try {
      await owner.advance({ phase: "cancelled" });
    } finally {
      await owner.release();
    }
  }
}

try {
  if (action === "capture") {
    const entries = await capture();

    await send({ type: "result", ok: true, entries });
  } else if (action === "owned-remove") {
    const fence = await acquirePreparationWorkspace(resource);

    try {
      await fence.run(() =>
        removeWorktree({
          projectRepoPath: input.repoPath,
          worktreePath: input.cwd,
          force: true,
        }),
      );
    } finally {
      await fence.release();
    }
    await send({ type: "result", ok: true });
  } else {
    // Explicit guard-disabled control uses real Git while capture is paused.
    await removeWorktree({
      projectRepoPath: input.repoPath,
      worktreePath: input.cwd,
      force: true,
    });
    await send({ type: "result", ok: true });
  }
} catch (error) {
  await send({
    type: "result",
    ok: false,
    reason: isMaisterError(error) ? error.details?.reason : "fixture_failed",
    diagnostic: operationalFailureDiagnostic(error, { stage: "baseline" }),
  });
} finally {
  await closeDb();
  process.disconnect?.();
}
