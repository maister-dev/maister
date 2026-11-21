import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { CompletionGitAnchor } from "./completion-policy";

import { eq } from "drizzle-orm";
import pino from "pino";

import { nodeAttempts } from "@/lib/db/schema";
import { isFencedError } from "@/lib/execution-host";
import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "completion-gate-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

type GateEvidenceInput = Readonly<{
  db: Db;
  client: BoundClient;
  nodeAttemptId: string;
  targetBranch: string;
  repoIdentity: string;
}>;

async function readAnchor(
  input: GateEvidenceInput,
): Promise<CompletionGitAnchor | null> {
  try {
    const result = await input.client.workspacePublication({
      action: "evidence",
      remote: "origin",
      headRef: `refs/heads/${input.targetBranch}`,
    });

    return result.evidence?.clean && result.repoIdentity === input.repoIdentity
      ? {
          head: result.headSha,
          base: result.evidence.baseSha,
          state: "captured",
        }
      : null;
  } catch (error: unknown) {
    if (isFencedError(error) || !isMaisterError(error)) throw error;
    log.warn(
      { nodeAttemptId: input.nodeAttemptId, code: error.code },
      "git evidence observation unavailable",
    );

    return null;
  }
}

async function capture(
  input: GateEvidenceInput,
  state: "captured" | "verified",
): Promise<void> {
  const observed = await readAnchor(input);

  await input.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ anchor: nodeAttempts.completionGitAnchor })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update");

    if (!row || row.anchor?.state === "invalid") return;
    const anchor = row.anchor ?? observed;
    const agrees =
      anchor &&
      observed &&
      anchor.head === observed.head &&
      anchor.base === observed.base;
    const next: CompletionGitAnchor =
      agrees && (row.anchor || state === "captured")
        ? { ...anchor, state }
        : {
            head: anchor?.head ?? "",
            base: anchor?.base ?? "",
            state: "invalid",
          };

    await tx
      .update(nodeAttempts)
      .set({ completionGitAnchor: next })
      .where(eq(nodeAttempts.id, input.nodeAttemptId));
  });
}

export async function captureGateEvidence(
  input: GateEvidenceInput,
): Promise<void> {
  await capture(input, "captured");
}

export async function confirmGateEvidence(
  input: GateEvidenceInput,
): Promise<void> {
  await capture(input, "verified");
}
