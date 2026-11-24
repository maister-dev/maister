import { z } from "zod";

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

export const capabilityRefIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_PATH_SEGMENT, "capabilityRefId must match /^[A-Za-z0-9._-]+$/")
  .refine(notDotRef, "capabilityRefId must not be '.', '..' or contain '..'");
