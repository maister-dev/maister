import "server-only";

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeAgentMaterializationPath,
  withAgentMaterializationLock,
} from "@/lib/agents/materialization-manifest";
import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";

/**
 * Serializes context creation and disposal per run without holding a Postgres
 * transaction across Git. Keep this OS-backed mutex outside disposable source
 * directories: unlinking it during cleanup would split concurrent owners.
 * Process exit releases the lock; timeout feeds the existing cleanup retry.
 */
export async function withOperationalContextLock<T>(
  runId: string,
  effect: () => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId))
    throw new MaisterError("CONFIG", "Invalid operational context owner", {
      details: { runId },
    });
  const relative = `.maister/operational-context-locks/${runId}`;
  const root = await assertSafeAgentMaterializationPath(
    runtimeRoot(),
    relative,
  );
  const directory = path.join(root, relative);

  await mkdir(directory, { recursive: true });
  await assertSafeAgentMaterializationPath(root, relative);

  return withAgentMaterializationLock(directory, effect);
}
