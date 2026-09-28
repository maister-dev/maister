import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { withdrawMessage } from "@/lib/librarian/conversation";
import { librarianErrorResponse } from "@/lib/librarian/http";

// ADR-185 (LCV-03): withdraw a queued message of the caller's conversation.
// The id is compared with the caller's own conversation; any other is 404.

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { messageId } = await params;

    if (!z.string().uuid().safeParse(messageId).success)
      return NextResponse.json(
        { code: "PRECONDITION", message: "message not found" },
        { status: 404 },
      );
    await withdrawMessage(user.id, messageId, getDb() as unknown as Db);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return librarianErrorResponse(err, "DELETE /api/librarian/messages/:id");
  }
}
