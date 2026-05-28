import "server-only";

import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { MaisterError } from "@/lib/errors";

export const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const notDotRef = (s: string): boolean =>
  s !== "." && s !== ".." && !s.includes("..");

export const flowIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SAFE_PATH_SEGMENT, "flowId must match /^[A-Za-z0-9._-]+$/")
  .refine(notDotRef, "flowId must not be '.', '..' or contain '..'");

export const versionTagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._+-]+$/, "version must match /^[A-Za-z0-9._+-]+$/")
  .refine(notDotRef, "version must not be '.', '..' or contain '..'");

// Git commit SHA — 40 hex chars in canonical form, or the literal
// "unknown" sentinel for pre-migration rows that have not yet been
// re-installed under the SHA-keyed regime. Stored in `flows.revision`
// and `runs.flow_revision`; used by the runner to derive the
// immutable bundle path.
export const flowRevisionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:[0-9a-f]{40}|unknown)$/,
    "revision must be a 40-char lowercase hex git SHA or the literal 'unknown' sentinel",
  );

export const projectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "projectSlug must be kebab-case");

export const sourceUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^[A-Za-z0-9._+\-/:@~]+$/,
    "source must contain only [A-Za-z0-9._+-/:@~]",
  );

export const workspaceRootSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => path.isAbsolute(p) && !p.split(path.sep).includes(".."),
    "workspaceRoot must be an absolute path with no '..' segments",
  );

function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fieldName: string,
): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");

    throw new MaisterError("FLOW_INSTALL", `Invalid ${fieldName}: ${msg}`);
  }

  return parsed.data;
}

// Length of the SHA prefix used in the on-disk cache directory name.
// 12 chars are eyeball-friendly and collision-safe for any plausible
// number of cached flow versions. The full SHA stays in the DB column.
const REVISION_SHORT_LEN = 12;

// Produce the absolute path to the immutable per-revision flow bundle
// in the system cache. Format: ~/.maister/flows/<flowRefId>@<sha[:12]>/.
// The revision MUST be a git commit SHA (or the "unknown" sentinel
// for pre-migration rows). The same (flowRefId, revision) pair always
// resolves to the same path — re-installs at a new commit land at a
// different directory, so runs pinned to the old revision keep reading
// the old bytes.
export function systemCachePath(flowRefId: string, revision: string): string {
  const id = validate(flowIdSchema, flowRefId, "flowRefId");
  const rev = validate(flowRevisionSchema, revision, "revision");
  const short = rev.slice(0, REVISION_SHORT_LEN);

  return path.join(os.homedir(), ".maister", "flows", `${id}@${short}`);
}

export function projectFlowSymlinkPath(
  workspaceRoot: string,
  projectSlug: string,
  flowId: string,
): string {
  const root = validate(workspaceRootSchema, workspaceRoot, "workspaceRoot");
  const slug = validate(projectSlugSchema, projectSlug, "projectSlug");
  const id = validate(flowIdSchema, flowId, "flowId");

  return path.join(root, ".maister", slug, "flows", id);
}
