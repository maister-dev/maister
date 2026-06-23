import "server-only";

import type {
  AuthoredCapabilityBody,
  AuthoredCapabilityRevision,
  AuthoredFlowPackageBody,
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
  AuthoredFlowPackageMetadata,
  AuthoredFlowPackageValidationIssue,
} from "@/lib/catalog/authored-types";
import type { FlowYamlV1 } from "@/lib/config.schema";

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import pino from "pino";
import { parse as parseYaml } from "yaml";

import { validateGraphManifest } from "@/lib/config";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import { manifestDigest } from "@/lib/flows/digest";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";

const log = pino({
  name: "flow-package-authoring",
  level: process.env.LOG_LEVEL ?? "info",
});

const SUPPORTED_FILE_KINDS = new Set<AuthoredFlowPackageFileKind>([
  "asset",
  "skill",
  "rule",
  "script",
  "agent_definition",
  "subagent",
  "schema",
  "template",
  "readme",
  "setup",
  "manifest",
]);

const AUTHORED_FLOW_PACKAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const AUTHORED_FLOW_PACKAGE_SLUG_MAX_LENGTH = 80;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function isAuthoredFlowPackageFileKind(
  value: string,
): value is AuthoredFlowPackageFileKind {
  return SUPPORTED_FILE_KINDS.has(value as AuthoredFlowPackageFileKind);
}

export function parseAuthoredFlowPackageSlug(
  value: string,
  context: string,
): string {
  const slug = value.trim();

  if (
    slug.length === 0 ||
    slug.length > AUTHORED_FLOW_PACKAGE_SLUG_MAX_LENGTH ||
    slug === "." ||
    slug === ".." ||
    slug.includes("..") ||
    !AUTHORED_FLOW_PACKAGE_SLUG_PATTERN.test(slug)
  ) {
    throw new MaisterError(
      "CONFIG",
      `invalid authored Flow package slug for ${context}: ${slug}`,
    );
  }

  return slug;
}

export function createAuthoredFlowPackageBody(args: {
  flowYaml: string;
  packageMetadata: AuthoredFlowPackageMetadata;
  files: AuthoredFlowPackageFile[];
}): AuthoredFlowPackageBody {
  return {
    flowYaml: args.flowYaml,
    manifest: null,
    packageMetadata: args.packageMetadata,
    files: args.files,
    validation: {
      status: "unknown",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };
}

export function validateAuthoredFlowPackageBody(
  body: AuthoredFlowPackageBody,
): AuthoredFlowPackageBody {
  const issues: AuthoredFlowPackageValidationIssue[] = [];
  const manifest = parseAndValidateManifest(body.flowYaml, issues);
  const files = normalizePackageFiles(body.files, issues);
  const digest = manifest ? manifestDigest(manifest) : null;
  const contentHash = hashPackageContent({
    flowYaml: body.flowYaml,
    files,
    metadata: body.packageMetadata,
  });

  if (issues.length > 0) {
    log.warn(
      {
        packageSlug: body.packageMetadata.slug,
        issueCount: issues.length,
        issues: issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
        })),
      },
      "authored Flow package validation failed",
    );
  }

  return {
    ...body,
    manifest: (manifest as AuthoredCapabilityBody | null) ?? null,
    files,
    validation: {
      status: issues.length === 0 ? "valid" : "invalid",
      issueCount: issues.length,
      issues,
      manifestDigest: digest,
      contentHash,
    },
  };
}

export function assertPublishableAuthoredFlowRevision(args: {
  revision: AuthoredCapabilityRevision;
  context: { projectSlug: string; slug: string; action: string };
}): void {
  if (args.revision.kind !== "flow") return;

  assertPublishableAuthoredFlowPackage({
    body: args.revision.body,
    context: args.context,
  });
}

export function assertPublishableAuthoredFlowPackage(args: {
  body: unknown;
  context: { projectSlug: string; slug: string; action: string };
}): AuthoredFlowPackageBody {
  const packageBody = authoredFlowPackageBodyFromUnknown({
    value: args.body,
    fallbackMetadata: {
      slug: args.context.slug,
      name: args.context.slug,
    },
    context: `${args.context.projectSlug}/${args.context.slug} during ${args.context.action}`,
  });
  const validated = validateAuthoredFlowPackageBody(packageBody);

  if (validated.validation.status === "valid") return validated;

  const issues = validated.validation.issues
    .map((issue) => `${issue.path}: ${issue.code}`)
    .join("; ");

  log.warn(
    {
      projectSlug: args.context.projectSlug,
      packageSlug: args.context.slug,
      action: args.context.action,
      issueCount: validated.validation.issueCount,
      issues: validated.validation.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
      })),
    },
    "authored Flow package publish refused",
  );

  throw new MaisterError(
    "CONFIG",
    `authored Flow package is not publishable for ${args.context.projectSlug}/${args.context.slug}: ${issues}`,
  );
}

export function authoredFlowPackageBodyFromUnknown(args: {
  value: unknown;
  fallbackMetadata: AuthoredFlowPackageMetadata;
  context: string;
}): AuthoredFlowPackageBody {
  if (!isRecord(args.value) || typeof args.value.flowYaml !== "string") {
    throw new MaisterError(
      "CONFIG",
      `missing flowYaml draft for ${args.context}`,
    );
  }

  return createAuthoredFlowPackageBody({
    flowYaml: args.value.flowYaml,
    packageMetadata: packageMetadataFromUnknown(
      args.value.packageMetadata,
      args.fallbackMetadata,
    ),
    files: Array.isArray(args.value.files)
      ? packageFilesFromUnknown(args.value.files, args.context)
      : [],
  });
}

export async function readAuthoredFlowPackageDirectory(
  sourceDir: string,
): Promise<AuthoredFlowPackageBody> {
  const root = path.resolve(sourceDir);
  const flowYamlPath = path.join(root, "flow.yaml");
  let flowYaml: string;

  try {
    flowYaml = decodeUtf8TextFile({
      bytes: await readFile(flowYamlPath),
      absolutePath: flowYamlPath,
      packagePath: "flow.yaml",
    });
  } catch (err) {
    if (err instanceof MaisterError) throw err;

    throw new MaisterError(
      "CONFIG",
      `Flow package at ${root} is missing flow.yaml`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const files = await readPackageFiles(root);
  const slug = resolvePackageSlug({
    flowYaml,
    root,
  });
  const packageName = packageNameFromFlowYaml(flowYaml) ?? slug;

  log.info(
    {
      sourceDir: root,
      packageSlug: slug,
      fileCount: files.length,
    },
    "authored Flow package import read",
  );

  return validateAuthoredFlowPackageBody(
    createAuthoredFlowPackageBody({
      flowYaml,
      packageMetadata: { slug, name: packageName },
      files,
    }),
  );
}

export async function writeAuthoredFlowPackageDirectory(
  body: AuthoredFlowPackageBody,
  outputDir: string,
): Promise<void> {
  const validated = validateAuthoredFlowPackageBody(body);

  if (validated.validation.status !== "valid") {
    throw new MaisterError(
      "CONFIG",
      `cannot export invalid authored Flow package ${body.packageMetadata.slug}: ${validated.validation.issueCount} validation issue(s)`,
    );
  }

  const target = path.resolve(outputDir);
  const parent = path.dirname(target);
  const temp = path.join(
    parent,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );

  try {
    await access(target);
    throw new MaisterError(
      "PRECONDITION",
      `export destination already exists: ${target}`,
    );
  } catch (err) {
    if (err instanceof MaisterError) throw err;
  }

  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });

  try {
    await writeFile(path.join(temp, "flow.yaml"), validated.flowYaml, "utf8");

    for (const file of validated.files) {
      const destination = path.join(temp, file.path);

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }

    await rename(temp, target);
    log.info(
      {
        outputDir: target,
        packageSlug: validated.packageMetadata.slug,
        fileCount: validated.files.length + 1,
        manifestDigest: validated.validation.manifestDigest,
        contentHash: validated.validation.contentHash,
      },
      "authored Flow package exported",
    );
  } catch (err) {
    await rm(temp, { recursive: true, force: true });
    throw err;
  }
}

async function readPackageFiles(
  root: string,
): Promise<AuthoredFlowPackageFile[]> {
  const files: AuthoredFlowPackageFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");

      if (relativePath === "flow.yaml") continue;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        log.warn(
          {
            root,
            packagePath: relativePath,
            entryKind: describePackageDirectoryEntry(entry),
          },
          "authored Flow package import refused non-regular entry",
        );

        throw new MaisterError(
          "CONFIG",
          `Flow package file ${relativePath} must be a regular file: ${absolutePath}`,
        );
      }

      files.push({
        kind: classifyPackageFilePath(relativePath),
        path: relativePath,
        content: decodeUtf8TextFile({
          bytes: await readFile(absolutePath),
          absolutePath,
          packagePath: relativePath,
        }),
      });
    }
  }

  await walk(root);

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export { classifyPackageFilePath as classifyPackageFile } from "@/lib/flows/editor/package-file-tree";

function packageNameFromFlowYaml(flowYaml: string): string | null {
  try {
    const parsed = parseYaml(flowYaml);

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { name?: unknown }).name === "string"
    ) {
      return (parsed as { name: string }).name;
    }
  } catch {
    return null;
  }

  return null;
}

function resolvePackageSlug(args: { flowYaml: string; root: string }): string {
  const manifestName = packageNameFromFlowYaml(args.flowYaml);
  const manifestSlug = manifestName
    ? tryParseAuthoredFlowPackageSlug(
        manifestName,
        `flow.yaml name for Flow package at ${args.root}`,
      )
    : null;

  if (manifestSlug) return manifestSlug;

  return parseAuthoredFlowPackageSlug(
    path.basename(args.root),
    `Flow package directory name at ${args.root}`,
  );
}

function tryParseAuthoredFlowPackageSlug(
  value: string,
  context: string,
): string | null {
  try {
    return parseAuthoredFlowPackageSlug(value, context);
  } catch (err) {
    if (err instanceof MaisterError) return null;
    throw err;
  }
}

function describePackageDirectoryEntry(entry: {
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  isSymbolicLink: () => boolean;
}): string {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isBlockDevice()) return "block_device";
  if (entry.isCharacterDevice()) return "character_device";
  if (entry.isFIFO()) return "fifo";
  if (entry.isSocket()) return "socket";

  return "unknown";
}

function packageMetadataFromUnknown(
  value: unknown,
  fallback: AuthoredFlowPackageMetadata,
): AuthoredFlowPackageMetadata {
  if (!isRecord(value)) return fallback;

  return {
    slug: typeof value.slug === "string" ? value.slug : fallback.slug,
    name: typeof value.name === "string" ? value.name : fallback.name,
    description:
      typeof value.description === "string" ? value.description : undefined,
    versionLabel:
      typeof value.versionLabel === "string" ? value.versionLabel : undefined,
  };
}

function packageFilesFromUnknown(
  value: unknown[],
  context: string,
): AuthoredFlowPackageFile[] {
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new MaisterError(
        "CONFIG",
        `package file at index ${index} must be an object for ${context}`,
      );
    }

    if (
      typeof item.kind !== "string" ||
      typeof item.path !== "string" ||
      typeof item.content !== "string"
    ) {
      throw new MaisterError(
        "CONFIG",
        `package file at index ${index} must include string kind, path, and content for ${context}`,
      );
    }

    return {
      kind: item.kind as AuthoredFlowPackageFile["kind"],
      path: item.path,
      content: item.content,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAndValidateManifest(
  flowYaml: string,
  issues: AuthoredFlowPackageValidationIssue[],
): FlowYamlV1 | null {
  let parsedYaml: unknown;

  try {
    parsedYaml = parseYaml(flowYaml);
  } catch (err) {
    issues.push({
      code: "yaml_parse",
      path: "flow.yaml",
      message: err instanceof Error ? err.message : String(err),
    });

    return null;
  }

  const parsed = flowYamlV1Schema.safeParse(parsedYaml);

  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((issue) => ({
        code: "schema" as const,
        path: `flow.yaml:${issue.path.join(".") || "(root)"}`,
        message: issue.message,
      })),
    );

    return null;
  }

  if (parsed.data.nodes) {
    try {
      validateGraphManifest(
        parsed.data,
        parsed.data.nodes,
        "authored-flow-package/flow.yaml",
      );
    } catch (err) {
      issues.push({
        code: "graph",
        path: "flow.yaml",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return parsed.data;
}

function normalizePackageFiles(
  files: readonly AuthoredFlowPackageFile[],
  issues: AuthoredFlowPackageValidationIssue[],
): AuthoredFlowPackageFile[] {
  const seen = new Set<string>();
  const seenPaths: string[] = [];

  return files.map((file) => {
    const normalizedPath = normalizePackagePath(file.path);
    const isSupportedKind = isAuthoredFlowPackageFileKind(file.kind);

    if (!isSupportedKind) {
      issues.push({
        code: "unsupported_kind",
        path: file.path,
        message: `unsupported package file kind: ${file.kind}`,
      });
    }

    if (!isSafePackagePath(file.path, normalizedPath)) {
      issues.push({
        code: "unsafe_path",
        path: file.path,
        message: "package file path must be relative and must not contain ..",
      });
    }

    if (seen.has(normalizedPath)) {
      issues.push({
        code: "duplicate_path",
        path: file.path,
        message: `duplicate package file path: ${normalizedPath}`,
      });
    }

    const conflictingPath = seenPaths.find((seenPath) =>
      hasPackagePathConflict(seenPath, normalizedPath),
    );

    if (conflictingPath) {
      issues.push({
        code: "path_conflict",
        path: file.path,
        message: `package file path conflicts with ${conflictingPath}`,
      });
    }

    seen.add(normalizedPath);
    seenPaths.push(normalizedPath);

    if (hasBinaryContent(file.content)) {
      issues.push({
        code: "binary_content",
        path: file.path,
        message: "package file content must be text",
      });
    }

    return {
      ...file,
      kind: isSupportedKind ? file.kind : "asset",
      path: normalizedPath,
    };
  });
}

function normalizePackagePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function isSafePackagePath(original: string, normalizedPath: string): boolean {
  if (original.startsWith("/") || original.startsWith("\\")) return false;
  if (original.replaceAll("\\", "/").split("/").includes("..")) return false;
  if (normalizedPath === "." || normalizedPath.length === 0) return false;
  if (normalizedPath.startsWith("../") || normalizedPath === "..") return false;

  return !normalizedPath.split("/").includes("..");
}

function hasPackagePathConflict(left: string, right: string): boolean {
  if (left === right) return false;

  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function hasBinaryContent(value: string): boolean {
  return value.includes("\u0000");
}

function decodeUtf8TextFile(args: {
  bytes: Buffer;
  absolutePath: string;
  packagePath: string;
}): string {
  try {
    return UTF8_DECODER.decode(args.bytes);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Flow package file ${args.packagePath} must be valid UTF-8 text: ${args.absolutePath}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

function hashPackageContent(args: {
  flowYaml: string;
  metadata: AuthoredFlowPackageMetadata;
  files: readonly AuthoredFlowPackageFile[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        flowYaml: args.flowYaml,
        metadata: args.metadata,
        files: args.files
          .map((file) => ({
            kind: file.kind,
            path: file.path,
            content: file.content,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }),
    )
    .digest("hex");
}
