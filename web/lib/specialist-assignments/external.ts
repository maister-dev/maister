import "server-only";

import type { TokenActor } from "@/lib/tokens/verify";

import { NextResponse } from "next/server";

import { privateErrorResponse } from "@/lib/api/private-json";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

/** Human API clients retain their actual identity; machine delegation requires its own governed principal. */
export async function handlePersonalAssignmentExt(
  request: Request,
  scopeLabel:
    | "assignments:read"
    | "assignments:submit"
    | "assignments:update"
    | "assignments:recover"
    | "assignments:accept"
    | "assignments:cancel"
    | "specialists:read"
    | "targets:recover",
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
      const response = privateErrorResponse(error, endpoint);

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
