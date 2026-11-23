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
import { assertUserHoldsLock } from "@/lib/local-packages/lock";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await catalogOwner(id);
    const body = applyBody.parse(await req.json());

    await assertUserHoldsLock(id, owner.actorId);
    const receipt = await withCatalogReceipt(
      id,
      async () => {
        await assertUserHoldsLock(id, owner.actorId);

        return applyCatalogPreview(owner, body);
      },
      () => readCatalogRequestReceipt(owner, body),
    );

    return NextResponse.json(receipt, {
      status: receipt.state === "pending" ? 202 : 200,
    });
  } catch (error) {
    return catalogResponse(error);
  }
}
