import "server-only";

import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";

import { parsePackageManifest, PACKAGE_MANIFEST_FILENAME } from "./manifest";

import { packageManifestMcpSchema } from "@/lib/config.schema";

export function validateCatalogFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
  changed: ReadonlySet<string>,
): Array<{ path: string; message: string }> {
  const manifest = files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME);

  if (!manifest) return [];
  const parsed = parsePackageManifest(manifest.content);

  if (!parsed.ok || !parsed.raw.delivery) return [];
  const declared = Array.isArray(parsed.raw.mcps) ? parsed.raw.mcps : [];

  return files.flatMap((f) => {
    const match = /^mcps\/([^/]+)\.(?:ya?ml|json)$/.exec(f.path);

    if (!match || (!changed.has(f.path) && !changed.has(manifest.path)))
      return [];
    const doc = parseDocument(f.content);
    const item = declared.find((m) => m?.id === match[1]);

    if (doc.errors.length)
      return [{ path: f.path, message: "Invalid MCP descriptor" }];
    const descriptor = packageManifestMcpSchema.safeParse(doc.toJS());

    if (
      !descriptor.success ||
      !item ||
      !isDeepStrictEqual(
        {
          ...descriptor.data,
          ...(item.scope && !descriptor.data.scope
            ? { scope: item.scope }
            : {}),
        },
        item,
      )
    )
      return [
        {
          path: f.path,
          message:
            "MCP descriptor, filename and executable manifest declaration must agree",
        },
      ];

    return [];
  });
}
