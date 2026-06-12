import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import {
  createPackageSource,
  listPackageSources,
} from "@/lib/packages/catalog";
import { packageErrorResponse } from "@/lib/packages/http";

// (ADR-087) Platform package-source catalog: list + create. Admin-only;
// identifiers: none (list) / body url validated by zod (the source URL is
// platform config, the same trust class as the ACP runner catalog).
const createBodySchema = z
  .object({
    url: z.string().min(1).max(512),
    note: z.string().max(512).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

function sourceDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    note: row.note ?? null,
    discovered: row.discovered ?? [],
    lastCheckedAt: row.lastCheckedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    const sources = await listPackageSources();

    return NextResponse.json({ sources: sources.map(sourceDto) });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-sources GET");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    const parsed = createBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const { id } = await createPackageSource(parsed.data);

    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-sources POST");
  }
}
