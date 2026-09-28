import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import {
  editPersonalMemory,
  forgetPersonalMemory,
  listPersonalMemory,
  memoryPatchSchema,
} from "@/lib/librarian/memory";

type RouteContext = { params: Promise<{ itemId: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const { itemId } = await context.params;
    const parsed = memoryPatchSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success)
      return invalidBody(
        parsed.error.issues[0]?.message ?? "invalid memory patch",
      );
    const db = getDb();

    await editPersonalMemory(owner.id, itemId, parsed.data, db);
    const view = await listPersonalMemory(owner.id, db);
    const item = view.items.find((entry) => entry.id === itemId);

    if (!item)
      throw new Error(`edited librarian memory item ${itemId} missing`);

    return NextResponse.json({ item });
  } catch (error) {
    return librarianErrorResponse(
      error,
      "PATCH /api/librarian/memory/[itemId]",
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const { itemId } = await context.params;

    await forgetPersonalMemory(owner.id, itemId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return librarianErrorResponse(
      error,
      "DELETE /api/librarian/memory/[itemId]",
    );
  }
}
