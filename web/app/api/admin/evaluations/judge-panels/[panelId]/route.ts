import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import {
  patchPanelBodySchema,
  toJudgePanelDto,
} from "@/lib/evaluations/config-schemas";
import { deletePanel, getPanel, patchPanel } from "@/lib/evaluations/config";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
  requireIfMatchRevision,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-panel",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ panelId: string }> },
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { panelId } = await params;
    const panel = await getPanel(panelId);

    return NextResponse.json({ panel: toJudgePanelDto(panel) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ panelId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    const { panelId } = await params;
    const expectedRevision = requireIfMatchRevision(req);
    const parsed = patchPanelBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const panel = await patchPanel({
      panelId,
      expectedRevision,
      name: parsed.data.name,
      roleBindings: parsed.data.roleBindings,
      policy: parsed.data.policy,
      enabled: parsed.data.enabled,
      updatedByUserId: user.id,
    });

    return NextResponse.json({ panel: toJudgePanelDto(panel) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ panelId: string }> },
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { panelId } = await params;
    const expectedRevision = requireIfMatchRevision(req);

    // The If-Match revision is enforced atomically inside the delete's WHERE
    // (stale → 409, missing → 404) — no read-then-delete race window.
    await deletePanel({ panelId, expectedRevision });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
