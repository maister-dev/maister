import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

const log = pino({
  name: "api/studio/packages/[ref]/fork",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ ref: string }> };

// Body fields (both optional). `forceNew` bypasses fork dedup to create a fresh
// copy ("Fork a new copy"). `customize` is the centralized "make a divergent
// copy" affordance: it forces a new copy AND names it `<ref> (custom)`. A
// missing/empty body is the common case → dedup; a malformed body never 422s
// here, it just falls back to the dedup default.
const bodySchema = z
  .object({
    forceNew: z.boolean().optional(),
    customize: z.boolean().optional(),
  })
  .strict();

// `ref` is the package name (url-param). It is resolved server-side to its
// newest install (resolveStudioPackageByRef); the body carries only the
// non-authority `forceNew` flag. Fork CREATES a local package (writes a working
// dir) → gated `requireGlobalRole("member")`, matching every other studio
// authoring mutation (create/commit/import/cut-version) — `requireSession`
// alone would admit `viewer`, inactive, and password-must-change accounts. Fork
// dedup: an existing active fork of the same `source_install_id` is returned
// with HTTP 200 (`alreadyExists: true`); a fresh fork is 201.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const { ref } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    const customize = parsed.success ? parsed.data.customize === true : false;
    // Customize is a deliberate divergent copy → always a fresh copy.
    const forceNew =
      customize || (parsed.success ? parsed.data.forceNew === true : false);
    const resolution = await resolveStudioPackageByRef(user.id, user.role, ref);

    if (resolution.status === "not-found") {
      return notFoundResponse("package not found");
    }
    if (resolution.status === "ambiguous" || !resolution.installId) {
      return notFoundResponse("package ref is ambiguous");
    }

    const result = await forkPackageToLocal({
      sourceInstallId: resolution.installId,
      sourceRef: ref,
      createdBy: user.id,
      forceNew,
      name: customize ? `${ref} (custom)` : undefined,
    });

    log.info(
      {
        ref,
        localPackageId: result.localPackageId,
        alreadyExists: result.alreadyExists === true,
        forceNew,
        customize,
      },
      "package forked to local",
    );

    return NextResponse.json(result, {
      status: result.alreadyExists ? 200 : 201,
    });
  } catch (err) {
    return errorResponse(err, log, "studio/packages/[ref]/fork POST");
  }
}
