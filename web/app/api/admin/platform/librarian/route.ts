import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { invalidBody, librarianErrorResponse } from "@/lib/librarian/http";
import {
  readLibrarianSettings,
  updateLibrarianSettings,
  type LibrarianSettings,
} from "@/lib/librarian/settings";

// ADR-183 (LCV-11): the librarian's platform settings. Global admin only; no
// admin route reads any user's conversation.

function result(settings: LibrarianSettings) {
  return {
    settings: { enabled: settings.enabled, runnerId: settings.runnerId },
    readiness: { state: settings.availability },
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    return NextResponse.json(result(await readLibrarianSettings(getDb())));
  } catch (err) {
    return librarianErrorResponse(err, "GET /api/admin/platform/librarian");
  }
}

const patchSchema = z
  .object({
    enabled: z.boolean(),
    runnerId: z.string().min(1).nullable().optional(),
  })
  .strict();

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    const parsed = patchSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success)
      return invalidBody("enabled is required; runnerId is a string or null");

    return NextResponse.json(
      result(await updateLibrarianSettings(parsed.data, user.id, getDb())),
    );
  } catch (err) {
    return librarianErrorResponse(err, "PATCH /api/admin/platform/librarian");
  }
}
