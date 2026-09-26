import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { librarianErrorResponse } from "@/lib/librarian/http";
import { stopLibrarianTurn } from "@/lib/librarian/turn-recovery";

// ADR-183 (LCV-08, LUI-07): "Stop response" — never a task run's "Stop run".

export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    await stopLibrarianTurn(user.id, getDb() as unknown as Db);

    return new NextResponse(null, { status: 202 });
  } catch (err) {
    return librarianErrorResponse(
      err,
      "POST /api/librarian/turns/current/stop",
    );
  }
}
