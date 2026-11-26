import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  catalogOwner,
  catalogResponse,
} from "@/lib/local-packages/catalog-http";
import { previewBody } from "@/lib/local-packages/catalog-contract";
import { resolveCatalogSource } from "@/lib/local-packages/catalog-sources";
import { previewCatalogImport } from "@/lib/local-packages/catalog-operation";
import {
  assertEditorHoldsLock,
  withWorkingDirLock,
} from "@/lib/local-packages/lock";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await catalogOwner(id);

    const { sessionId, ...body } = previewBody.parse(await req.json());
    const assertEditor = () =>
      assertEditorHoldsLock(id, owner.actorId, sessionId);

    await assertEditor();
    const selector =
      body.importId && body.sourceId === "mcp-registry"
        ? body.selector.slice(0, body.selector.lastIndexOf("@")) + "@latest"
        : body.selector;
    const source = await resolveCatalogSource({ ...body, selector });
    const preview = await withWorkingDirLock(id, async () => {
      await assertEditor();

      return previewCatalogImport(
        owner,
        source,
        body.destination,
        body.importId,
      );
    });

    return NextResponse.json(preview);
  } catch (error) {
    return catalogResponse(error);
  }
}
