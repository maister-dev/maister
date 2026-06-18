import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  addProjectRemote,
  fetchProjectRemote,
  listProjectRemotes,
  pushProjectRemote,
  reconcileOriginRepoUrl,
  removeProjectRemote,
  setProjectRemoteUrl,
  type RemotesProject,
} from "@/lib/git-remotes";
import { redactUrl } from "@/lib/repo-source";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-remotes",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

const addBodySchema = z
  .object({
    name: z.string().min(1).max(255),
    url: z.string().min(1).max(2048),
  })
  .strict();

const actionBodySchema = z
  .object({
    op: z.enum(["push", "fetch", "set-upstream"]),
    name: z.string().min(1).max(255),
    branch: z.string().min(1).max(255).optional(),
  })
  .strict();

const setUrlBodySchema = addBodySchema;

const deleteBodySchema = z
  .object({ name: z.string().min(1).max(255) })
  .strict();

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "project remotes API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Load + authorize the project; `projectId`/`repo_path` are server-state (the
// row), never the body — only the remote `name`/`url` are body-controlled.
async function authorize(slug: string): Promise<{
  db: any;
  project: RemotesProject & { repoUrl: string | null };
}> {
  await requireActiveSession();

  const db = getDb() as any;
  const rows = await db.select().from(projects).where(eq(projects.slug, slug));
  const project = rows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  await requireProjectAction(project.id, "editSettings");

  return {
    db,
    project: {
      id: project.id,
      repoPath: project.repoPath,
      repoUrl: project.repoUrl ?? null,
    },
  };
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const { db, project } = await authorize(slug);

    // Heal-on-read (invariant B): re-derive the origin cache from git when the
    // DB value drifted. Best-effort — never fails the list.
    await reconcileOriginRepoUrl({ db, project });
    const remotes = await listProjectRemotes(project.repoPath);

    return NextResponse.json({ remotes });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const { db, project } = await authorize(slug);
    const raw = await req.json().catch(() => null);
    const action = actionBodySchema.safeParse(raw);

    if (action.success) {
      const { op, name, branch } = action.data;

      if ((op === "push" || op === "set-upstream") && !branch) {
        throw new MaisterError("CONFIG", `${op} requires a branch`);
      }

      const result =
        op === "fetch"
          ? await fetchProjectRemote({ project, name })
          : await pushProjectRemote({
              project,
              name,
              branch: branch as string,
              setUpstream: op === "set-upstream",
            });

      log.info(
        { slug, op, name, warning: result.warning ?? null },
        "remote action",
      );

      return NextResponse.json(
        result.warning ? { ok: true, warning: result.warning } : { ok: true },
      );
    }

    const add = addBodySchema.safeParse(raw);

    if (!add.success) {
      throw new MaisterError(
        "CONFIG",
        "body must be a remote { name, url } or an action { op, name }",
      );
    }

    await addProjectRemote({
      db,
      project,
      name: add.data.name,
      url: add.data.url,
    });
    log.info({ slug, name: add.data.name }, "remote added");

    return NextResponse.json(
      {
        ok: true,
        remote: { name: add.data.name, url: redactUrl(add.data.url) },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const { db, project } = await authorize(slug);
    const parsed = setUrlBodySchema.safeParse(
      await req.json().catch(() => null),
    );

    if (!parsed.success) {
      throw new MaisterError("CONFIG", "body must be { name, url }");
    }

    await setProjectRemoteUrl({
      db,
      project,
      name: parsed.data.name,
      url: parsed.data.url,
    });
    log.info({ slug, name: parsed.data.name }, "remote url updated");

    return NextResponse.json({
      ok: true,
      remote: { name: parsed.data.name, url: redactUrl(parsed.data.url) },
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const { db, project } = await authorize(slug);
    const parsed = deleteBodySchema.safeParse(
      await req.json().catch(() => null),
    );

    if (!parsed.success) {
      throw new MaisterError("CONFIG", "body must be { name }");
    }

    await removeProjectRemote({ db, project, name: parsed.data.name });
    log.info({ slug, name: parsed.data.name }, "remote removed");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
