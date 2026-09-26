import "server-only";

import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { librarianErrorResponse } from "@/lib/librarian/http";
import { requestLibrarianReset } from "@/lib/librarian/reset";

export async function POST(): Promise<NextResponse> {
  try {
    const owner = await requireActiveSession();

    return NextResponse.json({
      resetState: await requestLibrarianReset(owner.id),
    });
  } catch (error) {
    return librarianErrorResponse(error, "POST /api/librarian/reset");
  }
}
