import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { advanceReadCursor } from "@/lib/librarian/conversation";
import {
  invalidBody,
  librarianErrorResponse,
  parseSeq,
} from "@/lib/librarian/http";

// ADR-185 (LUI-01): a monotonic GREATEST upsert of the caller's own cursor.

const bodySchema = z.object({ seq: z.string() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    const seq = parsed.success ? parseSeq(parsed.data.seq) : null;

    if (seq === null) return invalidBody("seq must be a canonical decimal");
    await advanceReadCursor(user.id, seq, getDb() as unknown as Db);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return librarianErrorResponse(err, "POST /api/librarian/read-cursor");
  }
}
