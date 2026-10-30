import type { ExportProjection } from "./types";

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type YAMLMap,
} from "yaml";

import { maisterYamlV2Schema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";
import { contentDigest } from "@/lib/evaluations/digest";
import { DEFAULT_PUBLIC_BRANCH_TEMPLATE } from "@/lib/workbench-git/public-branch-name";

type PackagePin = {
  id: string;
  source: string;
  version: string;
  path?: string;
};
export const MANIFEST_MAX_BYTES = 1024 * 1024;

function invalid(): never {
  throw new MaisterError(
    "CONFIG",
    "The manifest cannot be safely patched. Fix invalid YAML, duplicate keys, aliases or unsupported owned structures and preview again.",
    {
      details: { reason: "manifest_invalid" },
    },
  );
}

function document(source: string): ReturnType<typeof parseDocument> {
  if (Buffer.byteLength(source, "utf8") > MANIFEST_MAX_BYTES) {
    throw new MaisterError(
      "PRECONDITION",
      "The manifest exceeds the 1 MiB review limit.",
      { details: { reason: "manifest_too_large" } },
    );
  }
  const doc = parseDocument(source, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });

  if (doc.errors.length || !isMap(doc.contents)) invalid();
  visit(doc, (_, node) => {
    if (isAlias(node) || (isScalar(node) && node.value === "<<")) invalid();
  });

  return doc;
}

export function normalizedManifest(
  source: string,
): Omit<ExportProjection, "packages"> & { packages: PackagePin[] } {
  const parsed = maisterYamlV2Schema.safeParse(document(source).toJS());

  if (!parsed.success) invalid();
  const { project, packages } = parsed.data;

  if (new Set(packages.map((entry) => entry.id)).size !== packages.length)
    invalid();

  return {
    name: project.name,
    mainBranch: project.main_branch,
    branchPrefix: project.branch_prefix,
    publicBranchTemplate:
      project.public_branch_template ?? DEFAULT_PUBLIC_BRANCH_TEMPLATE,
    defaultRunnerId: project.default_runner ?? null,
    promotionMode: project.promotion?.mode ?? null,
    packages: [...packages].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function exportProjectionDigest(projection: ExportProjection): string {
  return contentDigest({
    ...projection,
    packages: projection.packages
      .map(({ resolvedRevision: _revision, ...pin }) => pin)
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function manifestMatches(
  source: string,
  projection: ExportProjection,
): boolean {
  return (
    contentDigest(normalizedManifest(source)) ===
    exportProjectionDigest(projection)
  );
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function eol(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function mapAt(source: string, path: readonly (string | number)[]): YAMLMap {
  const node = path.length
    ? document(source).getIn(path, true)
    : document(source).contents;

  if (!isMap(node) || node.flow || !node.range) invalid();

  return node;
}

function splice(
  source: string,
  start: number,
  end: number,
  text: string,
): string {
  return source.slice(0, start) + text + source.slice(end);
}

/** Replace scalar ranges only; unrelated bytes and inline comments remain untouched. */
function setLeaf(
  source: string,
  path: readonly (string | number)[],
  key: string,
  value: string | null,
): string {
  const map = mapAt(source, path);
  const pair = map.items.find(
    (item) => isScalar(item.key) && item.key.value === key,
  );

  if (pair) {
    if (
      !isScalar(pair.key) ||
      !pair.key.range ||
      !isScalar(pair.value) ||
      !pair.value.range
    )
      invalid();
    if (value === null) {
      const start = lineStart(source, pair.key.range[0]);
      const comment = pair.value.comment
        ? `${" ".repeat(pair.key.range[0] - start)}#${pair.value.comment}${eol(source)}`
        : "";

      return splice(source, start, pair.value.range[2], comment);
    }
    if (pair.value.value === value) return source;

    const rendered =
      pair.value.type === "QUOTE_DOUBLE" || value.includes("\n")
        ? JSON.stringify(value)
        : pair.value.type === "QUOTE_SINGLE"
          ? `'${value.replaceAll("'", "''")}'`
          : stringify(value).trimEnd();

    return splice(source, pair.value.range[0], pair.value.range[1], rendered);
  }
  if (value === null) return source;
  const start = map.range![0];
  const firstKey = map.items[0]?.key;

  if (!isScalar(firstKey) || !firstKey.range) invalid();
  const indent = firstKey.range[0] - lineStart(source, firstKey.range[0]);
  const offset = map.range![1];
  const prefix = offset > 0 && source[offset - 1] !== "\n" ? eol(source) : "";

  if (start > offset) invalid();

  return splice(
    source,
    offset,
    offset,
    `${prefix}${" ".repeat(indent)}${key}: ${JSON.stringify(value)}${eol(source)}`,
  );
}

/** Package edits use original leaf ranges; only added/deleted entries change structure. */
export function patchPackageEntries(
  source: string,
  desired: readonly PackagePin[],
): string {
  let result = source;
  const initial = document(result);
  const packages = initial.get("packages", true);

  if (
    packages === undefined ||
    (isSeq(packages) && packages.items.length === 0)
  ) {
    if (desired.length === 0) return result;
    const block = stringify(desired)
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join(eol(result));

    if (packages === undefined)
      return `${result}${result.endsWith("\n") ? "" : eol(result)}packages:${eol(result)}${block}${eol(result)}`;
    if (!packages.range) invalid();

    const start = lineStart(result, packages.range[0]);
    const inline = result
      .slice(start, packages.range[0])
      .trim()
      .startsWith("packages:");

    return splice(
      result,
      inline ? packages.range[0] : start,
      packages.range[1],
      `${inline ? eol(result) : ""}${block}`,
    );
  }
  if (!isSeq(packages) || packages.flow || packages.anchor) invalid();
  const ids = packages.items.map((item) => {
    if (
      !isMap(item) ||
      item.flow ||
      item.anchor ||
      typeof item.get("id") !== "string"
    )
      invalid();

    return item.get("id") as string;
  });

  if (new Set(ids).size !== ids.length) invalid();
  for (const id of ids) {
    const doc = document(result);
    const seq = doc.get("packages", true);

    if (!isSeq(seq)) invalid();
    const index = seq.items.findIndex(
      (node) => isMap(node) && node.get("id") === id,
    );
    const node = seq.items[index];
    const pin = desired.find((entry) => entry.id === id);

    if (!isMap(node) || !node.range) invalid();
    if (!pin) {
      const comments: string[] = [];

      visit(node, (_, child) => {
        if (isScalar(child) || isMap(child) || isSeq(child)) {
          if (child !== node && child.commentBefore)
            comments.push(...child.commentBefore.split("\n"));
          if (child.comment) comments.push(...child.comment.split("\n"));
        }
      });
      const start = lineStart(result, node.range[0]);
      const replacement = comments
        .map((comment) => `  #${comment}${eol(result)}`)
        .join("");

      result = splice(result, start, node.range[2], replacement);
      continue;
    }
    for (const key of ["source", "version", "path"] as const) {
      result = setLeaf(result, ["packages", index], key, pin[key] ?? null);
    }
  }
  const remaining = document(result).get("packages", true);

  if (remaining === null || (isScalar(remaining) && remaining.value === null)) {
    const root = mapAt(result, []);
    const key = root.items.find(
      (item) => isScalar(item.key) && item.key.value === "packages",
    )?.key;

    if (!isScalar(key) || !key.range) invalid();
    result = splice(result, key.range[1] + 1, key.range[1] + 1, " []");
  }

  const additions = desired.filter((pin) => !ids.includes(pin.id));

  if (additions.length) {
    const seq = document(result).get("packages", true);

    if (!isSeq(seq) || !seq.range) invalid();
    if (seq.items.length === 0) return patchPackageEntries(result, additions);
    const block = stringify(additions)
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join(eol(result));
    const offset = seq.range[1];

    result = splice(
      result,
      offset,
      offset,
      `${offset && result[offset - 1] !== "\n" ? eol(result) : ""}${block}${eol(result)}`,
    );
  }

  return result;
}

export function patchProjectManifest(
  source: string | null,
  projection: ExportProjection,
): string {
  if (source !== null && manifestMatches(source, projection)) return source;
  let result =
    source ?? "schemaVersion: 2\nproject:\n  name: placeholder\nflows: []\n";

  for (const [key, value, defaultValue] of [
    ["name", projection.name, null],
    ["main_branch", projection.mainBranch, "main"],
    ["branch_prefix", projection.branchPrefix, "maister/"],
    [
      "public_branch_template",
      projection.publicBranchTemplate,
      DEFAULT_PUBLIC_BRANCH_TEMPLATE,
    ],
    ["default_runner", projection.defaultRunnerId, null],
  ] as const) {
    const present = mapAt(result, ["project"]).has(key);

    result = setLeaf(
      result,
      ["project"],
      key,
      !present && value === defaultValue ? null : value,
    );
  }
  const promotion = document(result).getIn(["project", "promotion"], true);

  if (promotion === undefined && projection.promotionMode !== null) {
    const project = mapAt(result, ["project"]);
    const offset = project.range![1];

    result = splice(
      result,
      offset,
      offset,
      `  promotion:${eol(result)}    mode: ${JSON.stringify(projection.promotionMode)}${eol(result)}`,
    );
  } else if (promotion !== undefined) {
    result = setLeaf(
      result,
      ["project", "promotion"],
      "mode",
      projection.promotionMode,
    );
    const remaining = document(result).getIn(["project", "promotion"], true);

    if (
      remaining === null ||
      (isScalar(remaining) && remaining.value === null)
    ) {
      const project = mapAt(result, ["project"]);
      const key = project.items.find(
        (item) => isScalar(item.key) && item.key.value === "promotion",
      )?.key;

      if (!isScalar(key) || !key.range) invalid();
      result = splice(result, key.range[1] + 1, key.range[1] + 1, " {}");
    }
  }
  result = patchPackageEntries(
    result,
    projection.packages.map(({ resolvedRevision: _revision, ...pin }) => pin),
  );
  if (!manifestMatches(result, projection)) invalid();

  return result;
}
