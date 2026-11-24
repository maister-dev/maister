import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  catalogOwner,
  catalogResponse,
  withCatalogReceipt,
} from "@/lib/local-packages/catalog-http";
import { applyBody } from "@/lib/local-packages/catalog-contract";
import {
  applyCatalogPreview,
  readCatalogRequestReceipt,
} from "@/lib/local-packages/catalog-operation";
import { assertEditorHoldsLock } from "@/lib/local-packages/lock";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await catalogOwner(id);
    const { sessionId, ...body } = applyBody.parse(await req.json());
    const assertEditor = () =>
      assertEditorHoldsLock(id, owner.actorId, sessionId);

    await assertEditor();
    const receipt = await withCatalogReceipt(
      id,
      async () => {
        await assertEditor();

        return applyCatalogPreview(owner, body);
      },
      async () => {
        await assertEditor();

        return readCatalogRequestReceipt(owner, body);
      },
    );

    return NextResponse.json(receipt, {
      status: receipt.state === "pending" ? 202 : 200,
    });
  } catch (error) {
    return catalogResponse(error);
  }
}
