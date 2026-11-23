import "server-only";

import { NextResponse } from "next/server";

import {
  catalogOwner,
  catalogResponse,
  withCatalogReceipt,
} from "@/lib/local-packages/catalog-http";
import { readCatalogOperation } from "@/lib/local-packages/catalog-operation";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> },
): Promise<NextResponse> {
  try {
    const { id, operationId } = await params;
    const owner = await catalogOwner(id);

    const read = () => readCatalogOperation(owner, operationId);
    const receipt = await read();

    return NextResponse.json(
      receipt.state === "pending"
        ? await withCatalogReceipt(id, read, read)
        : receipt,
    );
  } catch (error) {
    return catalogResponse(error);
  }
}
