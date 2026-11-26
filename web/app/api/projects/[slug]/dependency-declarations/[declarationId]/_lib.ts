import "server-only";

import type { NextRequest } from "next/server";
import type { z } from "zod";
import type { getDb } from "@/lib/db/client";

import { NextResponse } from "next/server";

import {
  authorizePackageTrust,
  parseAuthorizedJson,
} from "../../flow-packages/_lib";

import { notFound, packageErrorResponse } from "@/lib/packages/http";

export function dependencyRoute<Input, Result>(
  schema: z.ZodType<Input>,
  command: (
    db: ReturnType<typeof getDb>,
    target: { projectId: string; actorUserId: string; declarationId: string },
    input: Input,
  ) => Promise<Result | null>,
  successStatus: 200 | 202,
) {
  return async function route(
    req: NextRequest,
    ctx: { params: Promise<{ slug: string; declarationId: string }> },
  ): Promise<NextResponse> {
    const { slug, declarationId } = await ctx.params;

    try {
      const { project, db, user: actor } = await authorizePackageTrust(slug);
      const input = await parseAuthorizedJson({
        req,
        schema,
        method: req.method,
      });
      const result = await command(
        db,
        { projectId: project.id, declarationId, actorUserId: actor.id },
        input,
      );

      return result === null
        ? notFound("Declaration not found in this project.")
        : NextResponse.json(result, { status: successStatus });
    } catch (err) {
      return packageErrorResponse(err, "project dependency command");
    }
  };
}
