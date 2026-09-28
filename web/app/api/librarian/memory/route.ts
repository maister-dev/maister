import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import {
  listPersonalMemory,
  memoryDraftSchema,
  rememberPersonalMemory,
} from "@/lib/librarian/memory";

export async function GET(): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();

    return NextResponse.json(await listPersonalMemory(owner.id));
  } catch (error) {
    return librarianErrorResponse(error, "GET /api/librarian/memory");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();
    const parsed = memoryDraftSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success)
      return invalidBody(
        parsed.error.issues[0]?.message ?? "invalid memory item",
      );
    const db = getDb();
    const itemId = await rememberPersonalMemory(owner.id, parsed.data, db);
    const view = await listPersonalMemory(owner.id, db);
    const item = view.items.find((entry) => entry.id === itemId);

    if (!item) throw new Error(`new librarian memory item ${itemId} missing`);

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return librarianErrorResponse(error, "POST /api/librarian/memory");
  }
}
