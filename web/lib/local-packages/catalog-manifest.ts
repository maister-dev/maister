import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { isScalar, isSeq, parseDocument } from "yaml";

import { parsePackageManifest, PACKAGE_MANIFEST_FILENAME } from "./manifest";

import { upsertPackageFile } from "@/lib/flows/editor/package-files-draft";
import { packageManifestMcpSchema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";

export function catalogManifest(yaml: string) {
  const parsed = parsePackageManifest(yaml);

  if (!parsed.ok) throw new MaisterError("CONFIG", parsed.error);
  const doc = parseDocument(yaml);

  if (!parsed.raw.delivery) {
    doc.set("delivery", { version: 1 });
    if (Array.isArray(parsed.raw.mcps)) {
      const mcps = parsed.raw.mcps.map((m: Record<string, unknown>) => ({
        ...m,
        scope: m.scope ?? "project",
      }));

      doc.set("mcps", mcps);
    }
  }

  return { doc, model: parsed.model };
}

export function registerSkillRoot(
  yaml: string,
  selected?: string,
): { root: string; yaml: string } {
  const { doc, model } = catalogManifest(yaml);
  const roots = model.capabilities.map((c) => c.path);
  const root =
    selected ?? (roots.length <= 1 ? (roots[0] ?? "capability") : undefined);

  if (
    !root ||
    (roots.length > 0 && !roots.includes(root)) ||
    (!roots.length && root !== "capability")
  )
    throw new MaisterError("CONFIG", "Select a declared capability root");
  if (!roots.length)
    doc.set("capabilities", [
      { id: model.name.slice(0, 120) + "-bundle", path: root },
    ]);

  return { root, yaml: String(doc) };
}

export function manifestMcp(
  yaml: string,
  id: string,
): Record<string, unknown> | undefined {
  const parsed = parsePackageManifest(yaml);

  if (!parsed.ok || !Array.isArray(parsed.raw.mcps)) return undefined;

  return parsed.raw.mcps.find((m: Record<string, unknown>) => m.id === id);
}

// Keep descriptor and executable declaration together as the author types. An
// incomplete raw edit remains editable and the cut validator reports the pair.
export function editMcpDescriptor(
  files: AuthoredFlowPackageFile[],
  filePath: string,
  content: string,
): AuthoredFlowPackageFile[] {
  const withFile = upsertPackageFile(files, filePath, content);
  const manifest = files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME);

  if (!manifest) return withFile;
  const id = filePath
    .split("/")
    .at(-1)!
    .replace(/\.(ya?ml|json)$/i, "");
  const doc = parseDocument(content);

  if (doc.errors.length) return withFile;
  const parsed = packageManifestMcpSchema.safeParse(doc.toJS());

  if (!parsed.success || parsed.data.id !== id) return withFile;
  const pkg = catalogManifest(manifest.content);
  const old =
    (
      pkg.doc.toJS() as {
        mcps?: Array<{ id: string; scope?: "package" | "project" }>;
      }
    ).mcps ?? [];

  const scope = parsed.data.scope ?? old.find((m) => m.id === id)?.scope;

  pkg.doc.set("mcps", [
    ...old.filter((m) => m.id !== id),
    { ...parsed.data, ...(scope ? { scope } : {}) },
  ]);

  return upsertPackageFile(
    withFile,
    PACKAGE_MANIFEST_FILENAME,
    String(pkg.doc),
  );
}

export function migrateLegacySkill(
  files: AuthoredFlowPackageFile[],
  id: string,
  root?: string,
): AuthoredFlowPackageFile[] {
  const manifest = files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME);

  if (!manifest) throw new MaisterError("CONFIG", "Missing package manifest");
  const registered = registerSkillRoot(manifest.content, root);
  const old = "skills/" + id + "/";
  const target = registered.root + "/" + old;

  if (!files.some((f) => f.path === old + "SKILL.md"))
    throw new MaisterError("CONFIG", "Legacy skill is missing SKILL.md");
  if (files.some((f) => f.path.startsWith(target)))
    throw new MaisterError("CONFLICT", "Destination skill already exists");

  return upsertPackageFile(files, manifest.path, registered.yaml).map((file) =>
    file.path.startsWith(old)
      ? { ...file, path: target + file.path.slice(old.length) }
      : file,
  );
}

function referenceDocument(
  content: string,
  kind: "mcps" | "skills",
  id: string,
  frontmatter: boolean,
) {
  // Limit rewrites to actual node settings and the packaged agent's profile.
  const section = frontmatter
    ? /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content)
    : null;

  if (frontmatter && !section) return null;
  const doc = parseDocument(section ? section[2] : content);

  if (doc.errors.length)
    throw new MaisterError(
      "CONFIG",
      "Cannot update references in malformed YAML",
    );
  const paths: Array<Array<string | number>> = [];

  if (frontmatter) paths.push(["capability_profile", kind]);
  else if (kind === "mcps") {
    const nodes = doc.toJS()?.nodes;

    for (const key of Object.keys(nodes ?? {})) {
      const node = Array.isArray(nodes) ? Number(key) : key;

      for (const owner of [
        ["nodes", node, "settings", "mcps"],
        ["nodes", node, "mcps"],
      ]) {
        paths.push(owner, [...owner, "required"], [...owner, "additional"]);
      }
    }
  }
  const matches = paths.filter((field) => {
    const refs = doc.getIn(field, true);

    return (
      isSeq(refs) && refs.items.some((ref) => isScalar(ref) && ref.value === id)
    );
  });

  return { doc, section, matches };
}

export function referencesCatalogItem(
  content: string,
  kind: "mcps" | "skills",
  id: string,
  frontmatter: boolean,
): boolean {
  return Boolean(
    referenceDocument(content, kind, id, frontmatter)?.matches.length,
  );
}

function renameReferences(
  content: string,
  kind: "mcps" | "skills",
  id: string,
  nextId: string | null,
  frontmatter: boolean,
): string {
  const found = referenceDocument(content, kind, id, frontmatter);

  if (!found?.matches.length) return content;
  const { doc, section, matches } = found;

  for (const field of matches) {
    const refs = doc.getIn(field, true);

    if (!isSeq(refs)) continue;
    const values = refs.toJSON() as string[];

    doc.setIn(field, [
      ...new Set(
        values.flatMap((ref) =>
          ref === id ? (nextId ? [nextId] : []) : [ref],
        ),
      ),
    ]);
  }
  const yaml = String(doc);

  return section
    ? section[1] +
        yaml.trimEnd() +
        section[3] +
        content.slice(section[0].length)
    : yaml;
}

const catalogOriginPath = /^catalog-origins\/[a-f0-9]{64}\.json$/;

export function rewriteSkillFolderImports(
  files: AuthoredFlowPackageFile[],
  oldPath: string,
  newPath: string | null,
): AuthoredFlowPackageFile[] {
  if (oldPath === newPath) return files;
  let next = files;

  for (const file of files) {
    if (!catalogOriginPath.test(file.path)) continue;
    const origin = JSON.parse(file.content) as {
      kind: string;
      destination: string;
    };

    if (
      origin.kind !== "skill" ||
      (origin.destination !== oldPath &&
        !origin.destination.startsWith(oldPath + "/"))
    )
      continue;
    const destination =
      newPath === null
        ? null
        : newPath + origin.destination.slice(oldPath.length);

    next = rewritePackageIdentity(
      next,
      "skills",
      origin.destination.split("/").at(-1)!,
      destination?.split("/").at(-1) ?? null,
      origin.destination,
      destination,
    );
  }

  return next;
}

export function rewritePackageIdentity(
  files: AuthoredFlowPackageFile[],
  kind: "mcps" | "skills",
  id: string,
  nextId: string | null,
  oldPath: string,
  newPath: string | null,
): AuthoredFlowPackageFile[] {
  return files.flatMap((file) => {
    if (catalogOriginPath.test(file.path)) {
      const origin = JSON.parse(file.content) as {
        destination: string;
        files: Record<string, string>;
      };

      if (origin.destination !== oldPath) return [file];
      if (!newPath) return [];
      const moved = Object.fromEntries(
        Object.entries(origin.files).map(([p, hash]) => [
          p === oldPath || p.startsWith(oldPath + "/")
            ? newPath + p.slice(oldPath.length)
            : p,
          hash,
        ]),
      );

      return [
        {
          ...file,
          content:
            JSON.stringify(
              { ...origin, destination: newPath, files: moved },
              null,
              2,
            ) + "\n",
        },
      ];
    }
    if (id === nextId) return [file];
    if (/^(?:maister-agents|agents)\/[^/]+\.md$/.test(file.path))
      return [
        {
          ...file,
          content: renameReferences(file.content, kind, id, nextId, true),
        },
      ];
    if (kind === "mcps" && /^flows\/.+\/flow\.ya?ml$/.test(file.path))
      return [
        {
          ...file,
          content: renameReferences(file.content, kind, id, nextId, false),
        },
      ];

    return [file];
  });
}

export function rewriteMcpIdentity(
  files: AuthoredFlowPackageFile[],
  oldPath: string,
  newPath: string | null,
): AuthoredFlowPackageFile[] {
  const name = (p: string) =>
    p
      .split("/")
      .at(-1)!
      .replace(/\.(ya?ml|json)$/i, "");
  const id = name(oldPath);

  if (
    newPath &&
    !/^mcps\/[A-Za-z0-9][A-Za-z0-9._-]*\.(ya?ml|json)$/.test(newPath)
  )
    throw new MaisterError("PRECONDITION", "Invalid MCP destination");
  if (newPath && newPath !== oldPath && files.some((f) => f.path === newPath))
    throw new MaisterError("CONFLICT", "MCP destination already exists");
  const nextId = newPath ? name(newPath) : null;
  const manifest = files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME);
  const declared = manifest && manifestMcp(manifest.content, id);

  if (
    nextId &&
    nextId !== id &&
    manifest &&
    manifestMcp(manifest.content, nextId)
  )
    throw new MaisterError("CONFLICT", "MCP reference already exists");
  const changed = files.flatMap((file) => {
    if (declared && file.path === PACKAGE_MANIFEST_FILENAME) {
      const doc = parseDocument(file.content);
      const entries = doc.toJS().mcps as Array<{ id: string }>;

      doc.set(
        "mcps",
        entries.flatMap((m) =>
          m.id === id ? (nextId ? [{ ...m, id: nextId }] : []) : [m],
        ),
      );

      return [{ ...file, content: String(doc) }];
    }
    if (file.path !== oldPath) return [file];
    if (!newPath) return [];
    if (!declared) return [{ ...file, path: newPath }];
    const doc = parseDocument(file.content);

    if (doc.errors.length || doc.get("id") !== id)
      throw new MaisterError(
        "CONFIG",
        "MCP descriptor ID differs from its manifest",
      );
    doc.set("id", nextId);

    return [{ ...file, path: newPath, content: String(doc) }];
  });

  return rewritePackageIdentity(changed, "mcps", id, nextId, oldPath, newPath);
}
