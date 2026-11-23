import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages } from "../../../../../flow-packages/_lib";

import { notFound, packageErrorResponse } from "@/lib/packages/http";
import {
  mcpScopeWriteSchema,
  setPackageMcpScope,
} from "@/lib/packages/mcp-scope";

export async function PUT(
  req: NextRequest,
  ctx: {
    params: Promise<{ slug: string; attachmentId: string; refId: string }>;
  },
): Promise<NextResponse> {
  const { slug, attachmentId, refId } = await ctx.params;
  try {
    const { project, db } = await authorizeManagePackages(slug);
    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return NextResponse.json(
        { code: "CONFIG", message: "Invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = mcpScopeWriteSchema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json(
        { code: "CONFIG", message: parsed.error.message },
        { status: 400 },
      );

    const result = await setPackageMcpScope(
      { projectId: project.id, attachmentId, refId, mutation: parsed.data },
      db,
    );
    if (!result) return notFound("Package MCP reference not found");
    const { declared, effective, origin, revision } = result;
    return NextResponse.json({ declared, effective, origin, revision });
  } catch (error) {
    return packageErrorResponse(error, "setAttachmentMcpScope");
  }
}
