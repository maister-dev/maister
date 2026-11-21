import { and, eq, isNull } from "drizzle-orm";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { projects, projectTokens } from "@/lib/db/schema";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { handleExt, recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { projectWaitSignalGrant } from "@/lib/waits/authority";
import {
  readWaitCommand,
  waitHttpError,
  waitSignalBody,
} from "@/lib/waits/http";
import { recordWaitSignalInTransaction } from "@/lib/waits/store";

const endpoint = "/api/v1/ext/runs/{runId}/waits/{waitId}/signal";
const scopeLabel = "waits:signal";
const method = "POST";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; waitId: string }> },
) {
  const { runId, waitId } = await context.params;
  const db = getDb();

  return handleExt(
    request,
    { db, scopeLabel, endpoint, method, successAuditInWork: true },
    async ({ actor, projectId }) => {
      if (actor.tokenKind !== "project")
        return privateJson(
          { code: "UNAUTHORIZED", message: "Project token required" },
          403,
        );

      try {
        const { key, body } = await readWaitCommand(request, waitSignalBody);

        return await db.transaction(async (tx) => {
          const [grant] = await tx
            .select({ id: projectTokens.id })
            .from(projectTokens)
            .where(projectWaitSignalGrant(projectId, actor.tokenId))
            .for("share");

          if (!grant)
            return privateJson(
              {
                code: "UNAUTHENTICATED",
                message: "Token authority expired or was revoked",
              },
              401,
            );
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(eq(projects.id, projectId), isNull(projects.archivedAt)),
            );

          if (!project)
            return privateJson(
              { code: "NOT_FOUND", message: "Wait not found" },
              404,
            );

          const { reason, ...receipt } = await recordWaitSignalInTransaction(
            tx,
            {
              runId,
              waitId,
              projectId,
              actor: { kind: "project_token", id: actor.tokenId },
              idempotencyKey: key,
              signal: body,
            },
          );

          if (reason === "wait_signal_issuer")
            return privateJson(
              {
                code: "UNAUTHORIZED",
                message: "The push CI wait requires its declared project token",
                details: { reason },
              },
              403,
            );
          if (reason === "wait_invalid_payload")
            return privateJson(
              {
                code: "CONFIG",
                message: "Invalid wait request",
                details: { reason },
              },
              422,
            );
          if (reason)
            return privateJson(
              {
                code: "CONFLICT",
                message: "The wait request conflicts with current state",
                details: { reason },
              },
              409,
            );

          const status = receipt.disposition === "duplicate" ? 200 : 202;

          await recordRequiredTokenAudit(
            {
              ...tokenAuditIdentity(actor),
              projectId,
              scopeUsed: scopeLabel,
              endpoint,
              method,
              result: "ok",
              statusCode: status,
            },
            tx,
          );

          return privateJson(receipt, status);
        });
      } catch (error: unknown) {
        return waitHttpError(error, endpoint);
      }
    },
  );
}
