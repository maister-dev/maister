import "server-only";

import type { NextResponse } from "next/server";
import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "@/lib/specialist-assignments/intake-types";

import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";
import { tokenHasScope } from "@/lib/tokens/scopes";
import { requirePersonalAssignmentUser } from "@/lib/specialist-assignments/external";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { MaisterError } from "@/lib/errors";

const endpoint = "POST /api/agents/[agentId]/event";
const MAX_PAYLOAD_BYTES = 32 * 1024;

async function readNativeWebhookJson(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    !request.body
  )
    throw new MaisterError(
      "CONFIG",
      "Native assignment webhook intake requires an application/json body",
    );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > MAX_PAYLOAD_BYTES)
        throw new MaisterError(
          "CONFIG",
          "Native assignment webhook body exceeds 32 KiB",
          { details: { reason: "native_webhook_body_too_large" } },
        );
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new MaisterError(
        "CONFIG",
        "Native assignment webhook body must be valid UTF-8 JSON",
      );
    throw error;
  }
}

type NativeWebhookSubmit = (
  db: Db,
  userId: string,
  agentId: string,
  deliveryId: string | null,
  value: unknown,
) => Promise<SpecialistIntakeReceipt>;

/** One authenticated, bounded transport serves native assignment webhooks; the domain adapter owns current scope and admission. */
export async function handleOwnedAgentWebhook(
  request: Request,
  rawAgentId: string,
  submit: NativeWebhookSubmit,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { scopeLabel: "agents:trigger", endpoint, method: "POST" },
    async ({ actor }) => {
      const userId = requirePersonalAssignmentUser(actor);

      if (!tokenHasScope(actor.scopes, "assignments:submit"))
        throw new MaisterError(
          "UNAUTHORIZED",
          "Native assignment webhook intake requires assignments:submit",
        );
      if (request.headers.has("x-maister-trigger-event-id"))
        throw new MaisterError(
          "CONFIG",
          "Native assignment webhook intake uses Idempotency-Key rather than a domain-event identity",
        );
      const agentId = decodeRouteParam(rawAgentId, "agentId");
      const value = await readNativeWebhookJson(request);
      const receipt = await submit(
        getDb(),
        userId,
        agentId,
        request.headers.get("idempotency-key"),
        value,
      );

      return knowledgeJson(receipt.assignment, receipt.duplicate ? 200 : 201);
    },
    (error) => {
      const response = knowledgeErrorResponse(error, endpoint);

      if (
        error instanceof MaisterError &&
        error.details?.reason === "native_webhook_body_too_large"
      )
        return knowledgeJson(
          {
            code: "CONFIG",
            message: "Native assignment webhook body exceeds 32 KiB",
          },
          413,
        );

      if (response.status === 400)
        return knowledgeJson(
          {
            code: "CONFIG",
            message: "Native assignment webhook request is invalid",
          },
          422,
        );

      return response;
    },
  );
}
