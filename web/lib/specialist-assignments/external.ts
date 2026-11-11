import "server-only";

import type { AssignmentAction } from "./access";
import type { TokenActor } from "@/lib/tokens/verify";

import { NextResponse } from "next/server";

import { knowledgeErrorResponse } from "@/lib/brain/knowledge-http";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

/** Human API clients retain their actual identity; machine delegation requires its own governed principal. */
export async function handlePersonalAssignmentExt(
  request: Request,
  scopeLabel: Extract<
    AssignmentAction,
    | "assignments:read"
    | "assignments:submit"
    | "assignments:recover"
    | "assignments:accept"
  >,
  endpoint: string,
  work: (userId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { scopeLabel, endpoint, method: request.method },
    async ({ actor }) => {
      return work(requirePersonalAssignmentUser(actor));
    },
    (error) => {
      const response = knowledgeErrorResponse(error, endpoint);

      return response.status === 400
        ? new NextResponse(response.body, {
            status: 422,
            headers: response.headers,
          })
        : response;
    },
  );
}

/** A bearer may act as a user only when its verified kind and owner actually identify that user. */
export function requirePersonalAssignmentUser(actor: TokenActor): string {
  if (
    actor.tokenKind !== "user" ||
    actor.ownerUserId === null ||
    actor.projectId !== null
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Specialist user requests require a global personal user token",
      {
        details: { reason: "personal_assignment_token_required" },
      },
    );

  return actor.ownerUserId;
}
