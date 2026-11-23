import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  catalogOwner,
  catalogResponse,
} from "@/lib/local-packages/catalog-http";
import { searchQuery } from "@/lib/local-packages/catalog-contract";
import { searchCatalog } from "@/lib/local-packages/catalog-sources";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    await catalogOwner(id);
    const query = searchQuery.parse(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    return NextResponse.json(await searchCatalog(query));
  } catch (error) {
    return catalogResponse(error);
  }
}
