import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireGlobalRole } from "@/lib/authz";
import { trustPackageRevision } from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

type RouteParams = { params: Promise<{ installId: string }> };

// (ADR-088) Platform-level package trust, keyed by installId — the Studio /
// sources surface. trustPackageRevision fans trust onto EVERY project attached
// to the install (and its flow revisions + capability imports), so the gate is
// GLOBAL admin. The project-attachment route resolves attId -> installId first;
// here the installId is the operative handle directly.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { installId } = await params;

  try {
    await requireGlobalRole("admin");

    const result = await trustPackageRevision({ packageInstallId: installId });

    if (result === null) {
      return notFound(`package install not found: ${installId}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(
      err,
      `admin/package-installs/${installId} trust`,
    );
  }
}
