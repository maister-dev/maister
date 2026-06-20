import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls } = schemaModule as unknown as Record<string, any>;

// Server-only accessor for an install's on-disk bundle path. Used by the Studio
// skill/agent detail pages to feed the confined `package-content` readers. The
// returned absolute path NEVER leaves the server — it is passed straight into a
// disk read and only rendered content/metadata crosses to the client.
export async function getStudioPackageInstalledPath(
  installId: string,
): Promise<string | null> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return null;

  return (install.installedPath as string | undefined) ?? null;
}
