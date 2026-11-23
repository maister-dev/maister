import "server-only";

import { NextResponse } from "next/server";

import {
  catalogOwner,
  catalogResponse,
} from "@/lib/local-packages/catalog-http";
import { readCatalogOperation } from "@/lib/local-packages/catalog-operation";
import { withWorkingDirLock } from "@/lib/local-packages/lock";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> },
): Promise<NextResponse> {
  try {
    const { id, operationId } = await params;
    const owner = await catalogOwner(id);

    return NextResponse.json(
      await withWorkingDirLock(id, () =>
        readCatalogOperation(owner, operationId),
      ),
    );
  } catch (error) {
    return catalogResponse(error);
  }
}
