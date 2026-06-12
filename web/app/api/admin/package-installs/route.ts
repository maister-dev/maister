import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { resolveTrust } from "@/lib/flows/trust";
import { installPackageRevision } from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, packageSources } = schemaModule as unknown as Record<
  string,
  any
>;

// (ADR-087) Two install forms: {sourceId, name, version} from a configured
// source, or {localPath, path?} for a LOCAL VERSION (admin-only abs path —
// the operator's own host, same trust class as registration's `path`).
// `installed_path` is NEVER projected to clients.
const installBodySchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    name: z.string().min(1).max(128).optional(),
    version: z.string().min(1).max(128).optional(),
    localPath: z
      .string()
      .min(1)
      .refine(
        (p) => p.startsWith("/") && !p.split("/").includes(".."),
        "localPath must be absolute and contain no '..' segment",
      )
      .optional(),
    path: z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith("/") && !p.split("/").includes(".."),
        "path must be a relative subdir without '..'",
      )
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const fromSource = body.sourceId !== undefined;
    const fromLocal = body.localPath !== undefined;

    if (fromSource === fromLocal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide exactly one of sourceId or localPath",
      });
    }
    if (fromSource && (!body.name || !body.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceId form requires name and version",
      });
    }
  });

function installDto(row: Record<string, any>): Record<string, unknown> {
  const manifest = row.manifest as {
    spec?: { flows?: Array<{ id: string }> };
  } | null;

  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    name: row.name,
    versionLabel: row.versionLabel,
    resolvedRevision: row.resolvedRevision,
    packageStatus: row.packageStatus,
    trustStatus: row.trustStatus,
    flows: manifest?.spec?.flows?.map((f) => f.id) ?? [],
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    const db = getDb() as any;
    const installs = await db.select().from(packageInstalls);

    return NextResponse.json({ installs: installs.map(installDto) });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-installs GET");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    const parsed = installBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const body = parsed.data;
    const db = getDb() as any;

    if (body.sourceId !== undefined) {
      const [source] = await db
        .select()
        .from(packageSources)
        .where(eq(packageSources.id, body.sourceId));

      if (!source)
        return notFound(`package source not found: ${body.sourceId}`);

      // Discovery records the packages/<dir> coordinate (dir may differ from
      // the manifest name); fall back to packages/<name> pre-discovery.
      const entry = (source.discovered ?? []).find(
        (d: { name: string }) => d.name === body.name,
      );
      const result = await installPackageRevision({
        source: source.url,
        version: body.version!,
        path: `packages/${entry?.dir ?? body.name!}`,
        trustStatus: resolveTrust(source.url),
        db,
      });

      return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
    }

    const result = await installPackageRevision({
      source: body.localPath!,
      version: "local",
      path: body.path,
      trustStatus: "trusted_by_policy",
      db,
    });

    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-installs POST");
  }
}
