"use server";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import pino from "pino";

import {
  createAuthoredCapability,
  getAuthoredCapability,
  publishAuthoredCapabilityLocal,
  updateAuthoredDraft,
} from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { MaisterError } from "@/lib/errors";
import {
  assertPublishableAuthoredFlowRevision,
  createAuthoredFlowPackageBody,
  parseAuthoredFlowPackageSlug,
  validateAuthoredFlowPackageBody,
} from "@/lib/flows/package-authoring";

const DEFAULT_FLOW_VERSION = 1;
const log = pino({
  name: "authored-flow-actions",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function createAuthoredFlowAction(
  formData: FormData,
): Promise<void> {
  const projectSlug = requireFormString(formData, "projectSlug");

  await authorizeCatalogRouteProject(projectSlug);

  const slug = parseAuthoredFlowPackageSlug(
    requireFormString(formData, "slug"),
    "create authored Flow",
  );
  const title = requireFormString(formData, "title");
  const flowYaml = defaultFlowYaml({ slug, title });
  const packageBody = validateAuthoredFlowPackageBody(
    createAuthoredFlowPackageBody({
      flowYaml,
      packageMetadata: { slug, name: title },
      files: [],
    }),
  );

  const result = await createAuthoredCapability({
    projectSlug,
    input: {
      kind: "flow",
      slug,
      title,
      body: packageBody,
      manifest: packageBody.manifest,
      schemaVersion: DEFAULT_FLOW_VERSION,
    },
  });

  revalidatePath("/flows");
  redirect(`/flows/${projectSlug}/${result.capability.id}`);
}

export async function updateAuthoredFlowAction(
  formData: FormData,
): Promise<void> {
  const projectSlug = requireFormString(formData, "projectSlug");

  await authorizeCatalogRouteProject(projectSlug);

  const capId = requireFormString(formData, "capId");
  const title = requireFormString(formData, "title");
  const flowYaml = requireFormRawString(formData, "flowYaml");
  const expectedDraftVersion = parseExpectedDraftVersion(
    requireFormString(formData, "expectedDraftVersion"),
    capId,
  );

  const detail = await getAuthoredCapability({ projectSlug, capId });
  const packageFiles = parsePackageFilesJson(
    optionalFormString(formData, "packageFilesJson") ?? "[]",
    { projectSlug, slug: capId, action: "update" },
  );

  const packageBody = validateAuthoredFlowPackageBody(
    createAuthoredFlowPackageBody({
      flowYaml,
      packageMetadata: { slug: detail.capability.slug, name: title },
      files: packageFiles,
    }),
  );

  log.info(
    {
      projectSlug,
      capId,
      draftVersion: expectedDraftVersion,
      status: packageBody.validation.status,
      issueCount: packageBody.validation.issueCount,
      fileCount: packageFiles.length,
    },
    "[FIX] authored Flow package files updated",
  );

  await updateAuthoredDraft({
    projectSlug,
    capId,
    input: {
      title,
      body: packageBody,
      manifest: packageBody.manifest,
      schemaVersion: DEFAULT_FLOW_VERSION,
      expectedDraftVersion,
    },
  });

  revalidatePath("/flows");
  revalidatePath(`/flows/${projectSlug}/${capId}`);
}

export async function publishAuthoredFlowAction(
  formData: FormData,
): Promise<void> {
  const projectSlug = requireFormString(formData, "projectSlug");

  await authorizeCatalogRouteProject(projectSlug);

  const capId = requireFormString(formData, "capId");
  const expectedDraftVersion = parseExpectedDraftVersion(
    requireFormString(formData, "expectedDraftVersion"),
    capId,
  );

  await publishAuthoredCapabilityLocal({
    projectSlug,
    capId,
    expectedDraftVersion,
    validateDraftRevision: (revision) => {
      assertPublishableAuthoredFlowRevision({
        revision,
        context: { projectSlug, slug: capId, action: "publish" },
      });
    },
  });

  revalidatePath("/flows");
  revalidatePath(`/flows/${projectSlug}/${capId}`);
}

function parseExpectedDraftVersion(value: string, capId: string): number {
  const expectedDraftVersion = Number(value);

  if (!Number.isInteger(expectedDraftVersion) || expectedDraftVersion < 1) {
    throw new MaisterError(
      "CONFIG",
      `invalid expectedDraftVersion for authored flow ${capId}: ${expectedDraftVersion}`,
    );
  }

  return expectedDraftVersion;
}

function optionalFormString(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  if (value === null) return null;
  if (typeof value !== "string") {
    throw new MaisterError("CONFIG", `invalid form field: ${key}`);
  }

  return value;
}

function parsePackageFilesJson(
  value: string,
  context: { projectSlug: string; slug: string; action: string },
): AuthoredFlowPackageFile[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid package files JSON for ${context.projectSlug}/${context.slug} during ${context.action}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new MaisterError(
      "CONFIG",
      `package files JSON must be an array for ${context.projectSlug}/${context.slug}`,
    );
  }

  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new MaisterError(
        "CONFIG",
        `package file at index ${index} must be an object for ${context.projectSlug}/${context.slug}`,
      );
    }

    const record = item as Record<string, unknown>;

    if (
      typeof record.kind !== "string" ||
      typeof record.path !== "string" ||
      typeof record.content !== "string"
    ) {
      throw new MaisterError(
        "CONFIG",
        `package file at index ${index} must include string kind, path, and content for ${context.projectSlug}/${context.slug}`,
      );
    }

    return {
      kind: record.kind as AuthoredFlowPackageFile["kind"],
      path: record.path,
      content: record.content,
    };
  });
}

function requireFormString(formData: FormData, key: string): string {
  const value = formData.get(key);

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaisterError("CONFIG", `missing form field: ${key}`);
  }

  return value.trim();
}

function requireFormRawString(formData: FormData, key: string): string {
  const value = formData.get(key);

  if (typeof value !== "string") {
    throw new MaisterError("CONFIG", `missing form field: ${key}`);
  }

  return value;
}

function defaultFlowYaml(args: { slug: string; title: string }): string {
  return [
    "schemaVersion: 1",
    `name: ${JSON.stringify(args.slug)}`,
    "compat:",
    "  engine_min: 1.1.0",
    "capabilities: []",
    "artifacts: []",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    `      prompt: ${JSON.stringify(`Plan ${args.title}`)}`,
    "    transitions:",
    "      success: review",
    "  - id: review",
    "    type: human",
    "    finish:",
    "      human:",
    "        role: maintainer",
    "        decisions: [approve]",
    "    transitions:",
    "      approve: done",
    "",
  ].join("\n");
}
