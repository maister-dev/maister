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

// Optimistic-concurrency guard on DELETE: the service delete is usage-guarded
// but has no revision arg, so re-assert the client's If-Match against the live
// row before removing it (stale → 409). Shared by DELETE below.
async function assertPanelRevision(
  panelId: string,
  expectedRevision: number,
): Promise<void> {
  const panel = await getPanel(panelId);

  if ((panel.revision as number) !== expectedRevision) {
    throw new MaisterError(
      "CONFLICT",
      `judge panel ${panelId} revision mismatch (expected ${expectedRevision})`,
    );
  }
}

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

    await assertPanelRevision(panelId, expectedRevision);
    await deletePanel({ panelId });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
