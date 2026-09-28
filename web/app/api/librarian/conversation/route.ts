import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import {
  getLibrarianConversationView,
  setMemoryEnabledNextSegment,
} from "@/lib/librarian/view";

// ADR-185 (LCV-01, LAU-01, LAU-09): the caller's own conversation. The owner
// is the SESSION user; no parameter names a user or a conversation.

export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    return NextResponse.json(
      await getLibrarianConversationView(user.id, getDb() as unknown as Db),
    );
  } catch (err) {
    return librarianErrorResponse(err, "GET /api/librarian/conversation");
  }
}

const patchSchema = z
  .object({ memoryEnabledNextSegment: z.boolean() })
  .strict();

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = patchSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success)
      return invalidBody("memoryEnabledNextSegment must be a boolean");
    const db = getDb() as unknown as Db;

    await setMemoryEnabledNextSegment(
      user.id,
      parsed.data.memoryEnabledNextSegment,
      db,
    );

    return NextResponse.json(await getLibrarianConversationView(user.id, db));
  } catch (err) {
    return librarianErrorResponse(err, "PATCH /api/librarian/conversation");
  }
}
