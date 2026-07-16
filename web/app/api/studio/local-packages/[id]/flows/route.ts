import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
  readJsonBody,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { createFlowInPackageSchema } from "@/lib/local-packages/create-flow-contract";
import {
  addFlowToLocalPackage,
  getLocalPackage,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/flows",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    flow: createFlowInPackageSchema.shape.flow,
  })
  .strict();

// `id` is route-owned and resolves the one package server-side. `sessionId` is
// solely the existing edit-lock bearer token; Flow identity and metadata come
// from the typed body and no cross-package/project identifier is accepted.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const body = await readJsonBody(req);

    if (!body.ok) {
      return NextResponse.json(
        { code: "CONFIG", message: "request body must be valid JSON" },
        { status: 422 },
      );
    }

    const parsed = bodySchema.safeParse(body.body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const created = await addFlowToLocalPackage({
      packageId: id,
      sessionId: parsed.data.sessionId,
      flow: parsed.data.flow,
    });

    return NextResponse.json(
      {
        createdFlow: { id: parsed.data.flow.id, path: created.flowPath },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/flows POST");
  }
}
