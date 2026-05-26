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

export function systemCachePath(flowId: string, version: string): string {
  const v = validate(versionTagSchema, version, "version");
  const id = validate(flowIdSchema, flowId, "flowId");

  return path.join(os.homedir(), ".maister", "flows", `${id}@${v}`);
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
