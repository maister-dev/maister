import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { CatalogError } from "@/lib/local-packages/catalog-client";
import { fetchRegistryPage } from "@/lib/local-packages/catalog-registry";
import {
  searchCatalog,
  resolveCatalogSource,
  type CatalogClient,
} from "@/lib/local-packages/catalog-sources";
import {
  applyCatalogPreview,
  previewCatalogImport,
  readCatalogOperation,
} from "@/lib/local-packages/catalog-operation";

const sha = "f".repeat(40);
const skill =
  "---\nname: design\ndescription: Design a site.\n---\nOpen companion.md\n";
const payloads = new Map<string, string>();

function blob(file: string, content: string) {
  const bytes = Buffer.from(content);
  const id = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

  payloads.set(id, bytes.toString("base64"));

  return {
    path: file,
    type: "blob",
    mode: "100644",
    size: bytes.length,
    sha: id,
  };
}

const tree = [
  blob("skills/design/SKILL.md", skill),
  blob("skills/design/companion.md", "follow this path"),
  blob("LICENSE", "license terms"),
];
const read: CatalogClient = async (url) => {
  expect(url.hostname).toBe("api.github.com");
  if (url.pathname.endsWith("/commits/HEAD"))
    return { sha, commit: { tree: { sha } } };
  if (url.pathname.endsWith("/git/trees/" + sha))
    return { truncated: false, tree };
  const value = payloads.get(url.pathname.split("/").at(-1)!);

  if (value) return { encoding: "base64", content: value };
  throw new Error("Unexpected catalog read");
};
let draft = "";

afterEach(async () => {
  vi.unstubAllEnvs();
  if (draft) await rm(path.dirname(draft), { recursive: true, force: true });
  draft = "";
});

describe("reviewed Studio import", () => {
  it("IT-CAT-01 discovers a public skills.sh listing without a repository configuration and reviews pinned Git files", async () => {
    vi.stubEnv("MAISTER_STUDIO_CATALOG_REPOS", "[]");
    vi.stubEnv("AUTH_SECRET", "fixture-catalog-signing-key");
    const repo = "public-publisher/checkout-skills";
    const id = `${repo}/design`;
    const reads: URL[] = [];
    const catalog: CatalogClient = async (url) => {
      reads.push(url);
      if (url.hostname === "skills.sh") {
        if (url.pathname.startsWith("/api/download/")) {
          if (url.pathname !== `/api/download/${id}`)
            throw new CatalogError(404, "No cached snapshot");

          return {
            files: [{ path: "SKILL.md", contents: skill }],
            hash: "a".repeat(64),
          };
        }

        expect(url.pathname).toBe("/api/search");

        return {
          skills: [
            { id, source: repo, name: "design" },
            { id: `${id}-foreign`, source: "other/publisher", name: "foreign" },
            {
              id: "example.com/design",
              source: "example.com",
              name: "website",
            },
          ],
        };
      }
      expect(url.pathname).toContain(`/repos/${repo}/`);
      if (url.pathname.includes("/git/trees/"))
        return {
          truncated: false,
          tree: [
            ...tree.map((entry) => ({
              ...entry,
              path: entry.path.replace(
                /^skills\/design\//,
                "library/workflow/",
              ),
            })),
            blob(
              "library/design/SKILL.md",
              skill.replace("name: design", "name: other"),
            ),
          ],
        };

      return read(url);
    };
    const query = await searchCatalog(
      { kind: "skill", q: "checkout journey" },
      catalog,
    );

    expect(query.results).toMatchObject([
      {
        sourceId: "skills.sh",
        publisher: repo,
        name: "design",
        canonicalSkillId: id,
      },
    ]);
    expect(reads[0].searchParams.get("q")).toBe("checkout journey");
    expect(reads).toHaveLength(1);
    const selector = query.results[0].resultId;
    const resolve = (selection: string) =>
      resolveCatalogSource(
        { kind: "skill", sourceId: "skills.sh", selector: selection },
        catalog,
      );

    await expect(resolve(`a${selector}`)).rejects.toMatchObject({
      status: 422,
    });
    expect(reads).toHaveLength(1);
    const pinned = await resolve(selector);

    expect(pinned).toMatchObject({
      selector: id,
      pin: sha,
      sourceUrl: `https://github.com/${repo}/tree/${sha}/library/workflow`,
      files: { "SKILL.md": skill, "companion.md": "follow this path" },
    });
    expect(reads.filter((url) => url.hostname === "skills.sh")).toHaveLength(1);
    await expect(resolve(pinned.selector)).resolves.toEqual(pinned);
    expect(
      reads
        .filter((url) => url.hostname === "skills.sh")
        .map((url) => url.pathname),
    ).toEqual(["/api/search", `/api/download/${id}`]);
    await expect(resolve(`${repo}/missing`)).rejects.toMatchObject({
      status: 503,
      details: { reason: "catalog_identity_unavailable" },
    });
    const fromLink = await searchCatalog(
      { kind: "skill", q: `https://skills.sh/${id}` },
      catalog,
    );

    expect(fromLink.results).toEqual(query.results);
  });

  it("IT-CAT-01 refuses ambiguous declarations and keeps a root skill confined to its manifest and notices", async () => {
    const repo = "public-publisher/root-skill";
    const id = `${repo}/design`;
    const root = blob("SKILL.md", skill);
    const unrelated = blob(".github/readme.txt", "repository metadata");
    const resolve = (entryList: typeof tree) =>
      resolveCatalogSource(
        { kind: "skill", sourceId: "skills.sh", selector: id },
        async (url) => {
          if (url.pathname === `/api/download/${id}`)
            return {
              files: [{ path: "SKILL.md", contents: skill }],
              hash: "a".repeat(64),
            };
          if (url.pathname.includes("/git/trees/"))
            return { truncated: false, tree: entryList };

          return read(url);
        },
      );

    await expect(resolve([root, unrelated, ...tree])).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      resolve([
        blob(
          "skills/design/SKILL.md",
          skill.replace("name: design", "name: other"),
        ),
      ]),
    ).rejects.toMatchObject({ status: 404 });
    const pinned = await resolve([root, unrelated, tree[2]]);

    expect(pinned.sourceUrl).toBe(`https://github.com/${repo}/tree/${sha}`);
    expect(pinned.files).toEqual({
      "SKILL.md": skill,
      LICENSE: "license terms",
    });
  });

  it("IT-CAT-01 scopes live requests and exposes verified shared identities across sources", async () => {
    vi.stubEnv("AUTH_SECRET", "fixture-catalog-signing-key");
    const repo = "public-publisher/checkout-skills";
    const id = `${repo}/design`;

    vi.stubEnv(
      "MAISTER_STUDIO_CATALOG_REPOS",
      JSON.stringify([
        { id: "published-design", repo, kind: "skill" },
        {
          id: "other-design",
          repo: "separate-publisher/design",
          kind: "skill",
        },
      ]),
    );
    const controller = new AbortController();
    const readGlobal = vi.fn<CatalogClient>(async (url) => {
      expect(url.hostname).toBe("skills.sh");

      return { skills: [{ id, source: repo, name: "design" }] };
    });
    const global = await searchCatalog(
      { kind: "skill", q: "design", scope: "skills.sh" },
      readGlobal,
      controller.signal,
    );

    expect(readGlobal).toHaveBeenCalledExactlyOnceWith(
      expect.any(URL),
      controller.signal,
    );
    expect(global.results).toEqual([
      expect.objectContaining({ canonicalSkillId: id, sourceId: "skills.sh" }),
    ]);

    const configured = await searchCatalog(
      { kind: "skill", q: "design", scope: "repositories" },
      read,
    );

    expect(configured.results).toEqual([
      expect.objectContaining({
        sourceId: "published-design",
        canonicalSkillId: id,
      }),
      expect.objectContaining({
        sourceId: "other-design",
        canonicalSkillId: "separate-publisher/design/design",
      }),
    ]);
    const ambiguous = await searchCatalog(
      { kind: "skill", q: "design", scope: "repositories" },
      async (url) =>
        url.pathname.includes(`/repos/${repo}/git/trees/`)
          ? {
              truncated: false,
              tree: [
                ...tree,
                { ...tree[0], path: "skills/design-alt/SKILL.md" },
              ],
            }
          : read(url),
    );

    expect(
      ambiguous.results
        .filter((item) => item.sourceId === "published-design")
        .map(({ resultId, canonicalSkillId }) => ({
          resultId,
          canonicalSkillId,
        })),
    ).toEqual([
      { resultId: "skills/design", canonicalSkillId: undefined },
      { resultId: "skills/design-alt", canonicalSkillId: undefined },
    ]);
    await expect(
      searchCatalog(
        { kind: "skill", q: `https://skills.sh/${id}`, scope: "skills.sh" },
        async () => {
          throw new CatalogError(404, "No cached snapshot");
        },
      ),
    ).resolves.toMatchObject({
      results: [],
      sources: [
        {
          sourceId: "skills.sh",
          state: "unavailable",
          reason: "catalog_identity_unavailable",
        },
      ],
    });
  });

  it("IT-CAT-01 resolves approved repository items and their exact companion bytes", async () => {
    const result = await searchCatalog({ kind: "skill", q: "design" }, read);
    const found = result.results.find((r) => r.sourceId === "anthropic-skills");

    expect(found?.name).toBe("design");
    const pinned = await resolveCatalogSource(
      {
        kind: "skill",
        sourceId: "anthropic-skills",
        selector: found!.resultId,
      },
      read,
    );

    expect(pinned.pin).toBe(sha);
    expect(pinned.files).toEqual(
      expect.objectContaining({
        "companion.md": "follow this path",
        "SKILL.md": skill,
      }),
    );
    expect(pinned.notices.length).toBe(1);
    await expect(
      resolveCatalogSource(
        { kind: "skill", sourceId: "unapproved", selector: found!.resultId },
        read,
      ),
    ).rejects.toThrow();
  });

  it("IT-CAT-01 reuses a verified blob within one review while keeping every member and its size check", async () => {
    const member = tree[1];
    let reads = 0;
    const resolve = (size: number) =>
      resolveCatalogSource(
        {
          kind: "skill",
          sourceId: "anthropic-skills",
          selector: "skills/design",
        },
        async (url) => {
          if (url.pathname.includes("/git/trees/"))
            return {
              truncated: false,
              tree: [
                ...tree,
                { ...member, path: "skills/design/repeat.md", size },
              ],
            };
          if (url.pathname.endsWith("/git/blobs/" + member.sha)) reads++;

          return read(url);
        },
      );

    const resolved = await resolve(member.size);

    expect(resolved.files["repeat.md"]).toBe(resolved.files["companion.md"]);
    expect(reads).toBe(1);
    await expect(resolve(member.size + 1)).rejects.toMatchObject({
      status: 422,
    });
    expect(reads).toBe(2);
  });

  it("IT-CAT-03 applies one reviewed tree, recovers a lost reply and detects local changes before update", async () => {
    draft = path.join(
      await mkdtemp(path.join(tmpdir(), "maister-catalog-")),
      "worktree",
    );
    await mkdir(draft);
    await writeFile(
      path.join(draft, "maister-package.yaml"),
      "schemaVersion: 1\nname: demo\nflows: []\n",
    );
    const owner = { workingDir: draft, packageId: "draft", actorId: "editor" };
    const source = await resolveCatalogSource(
      {
        kind: "skill",
        sourceId: "anthropic-skills",
        selector: "skills/design",
      },
      read,
    );
    const preview = await previewCatalogImport(
      owner,
      source,
      "capability/skills/design",
    );

    expect(preview).toHaveProperty("runnerCompatibility", null);
    expect(preview.migratesLegacyManifest).toBe(true);
    const request = {
      previewId: preview.previewId,
      expectedDraftBase: preview.expectedDraftBase,
      requestKey: "import-once",
    };
    const receipt = await applyCatalogPreview(owner, request);

    expect(await applyCatalogPreview(owner, request)).toEqual(receipt);
    expect(await readCatalogOperation(owner, receipt.operationId)).toEqual(
      receipt,
    );
    await expect(
      previewCatalogImport(owner, source, "capability/skills/design"),
    ).rejects.toMatchObject({
      status: 409,
      details: { reason: "already_imported" },
    });
    expect(
      await readFile(
        path.join(draft, "capability/skills/design/SKILL.md"),
        "utf8",
      ),
    ).toBe(skill);
    const manifest = parse(
      await readFile(path.join(draft, "maister-package.yaml"), "utf8"),
    );

    expect(manifest.capabilities).toEqual([
      { id: "demo-bundle", path: "capability" },
    ]);
    await expect(
      applyCatalogPreview({ ...owner, actorId: "other" }, request),
    ).rejects.toThrow();
    await writeFile(
      path.join(draft, "capability/skills/design/companion.md"),
      "local edit",
    );
    await mkdir(path.join(draft, "agents"));
    await writeFile(
      path.join(draft, "agents/designer.md"),
      "---\ncapability_profile: {skills: [design]}\n---\nDesign",
    );
    await writeFile(
      path.join(draft, "capability/skills/design/SKILL.md"),
      skill + "Local note",
    );
    const next = {
      ...source,
      pin: "b".repeat(40),
      files: { ...source.files, "companion.md": "upstream edit" },
    };
    const update = await previewCatalogImport(
      owner,
      next,
      "capability/skills/design",
      preview.importId,
    );

    expect(update.affectedRefs).toContain("agents/designer.md");
    expect(update.migratesLegacyManifest).toBe(false);
    expect(update.files).toContainEqual(
      expect.objectContaining({
        path: "capability/skills/design/SKILL.md",
        change: "local",
      }),
    );
    expect(update.files).toContainEqual(
      expect.objectContaining({
        path: "capability/skills/design/companion.md",
        change: "conflict",
      }),
    );
    const change = {
      previewId: update.previewId,
      expectedDraftBase: update.expectedDraftBase,
      requestKey: "update-once",
    };

    await expect(applyCatalogPreview(owner, change)).rejects.toMatchObject({
      status: 409,
      details: { reason: "resolutions_required" },
    });
    await applyCatalogPreview(owner, {
      ...change,
      resolutions: [
        { path: "capability/skills/design/companion.md", use: "draft" },
      ],
    });
    expect(
      await readFile(
        path.join(draft, "capability/skills/design/companion.md"),
        "utf8",
      ),
    ).toBe("local edit");
    expect(
      await readFile(
        path.join(draft, "capability/skills/design/SKILL.md"),
        "utf8",
      ),
    ).toBe(skill + "Local note");
  });

  it("IT-CAT-03 refuses a destination collision before creating an origin or overwriting a local companion", async () => {
    draft = path.join(
      await mkdtemp(path.join(tmpdir(), "maister-catalog-")),
      "worktree",
    );
    const destination = "capability/skills/design";
    const local = path.join(draft, destination, "companion.md");
    const manifest = "schemaVersion: 1\nname: demo\nflows: []\n";

    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(path.join(draft, "maister-package.yaml"), manifest);
    await writeFile(local, "unrelated local bytes");
    const source = await resolveCatalogSource(
      {
        kind: "skill",
        sourceId: "anthropic-skills",
        selector: "skills/design",
      },
      read,
    );

    await expect(
      previewCatalogImport(
        { workingDir: draft, packageId: "draft", actorId: "editor" },
        source,
        destination,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(readFile(local, "utf8")).resolves.toBe(
      "unrelated local bytes",
    );
    await expect(
      readFile(path.join(draft, "maister-package.yaml"), "utf8"),
    ).resolves.toBe(manifest);
    await expect(
      readFile(path.join(draft, destination, "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(path.dirname(draft), ".maister-catalog")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("migrates a legacy skill tree only when an author selects a registered root", async () => {
  const { migrateLegacySkill } = await import("../catalog-manifest");
  const files = [
    {
      kind: "manifest" as const,
      path: "maister-package.yaml",
      content:
        "name: demo\ncapabilities:\n - { id: design, path: bundles/design }\n - { id: core, path: bundles/core }\n",
    },
    { kind: "skill" as const, path: "skills/demo/SKILL.md", content: skill },
    {
      kind: "asset" as const,
      path: "skills/demo/reference.md",
      content: "preserved",
    },
  ];

  expect(() => migrateLegacySkill(files, "demo")).toThrow();
  const moved = migrateLegacySkill(files, "demo", "bundles/design");

  expect(moved.map((f) => f.path)).toEqual([
    "maister-package.yaml",
    "bundles/design/skills/demo/SKILL.md",
    "bundles/design/skills/demo/reference.md",
  ]);
  expect(moved[2].content).toBe("preserved");
});

it("keeps executable descriptor, agent and Flow references aligned through rename and removal", async () => {
  const { rewriteMcpIdentity } = await import("../catalog-manifest");
  const { validateCatalogFiles } = await import("../catalog-validate");
  const files = [
    {
      kind: "manifest" as const,
      path: "maister-package.yaml",
      content:
        "name: demo\ndelivery: {version: 1}\nmcps:\n - { id: design, transport: http, url: https://example.com/mcp }\n",
    },
    {
      kind: "asset" as const,
      path: "mcps/design.yaml",
      content: "id: design\ntransport: http\nurl: https://example.com/mcp\n",
    },
    {
      kind: "agent_definition" as const,
      path: "maister-agents/designer.md",
      content:
        "---\ncapability_profile: { mcps: [design, other] }\n---\nDo design",
    },
    {
      kind: "asset" as const,
      path: "flows/client/flow.yaml",
      content:
        "nodes:\n - id: draw\n   settings: {mcps: { required: [design], additional: [other] }}\n",
    },
  ];
  const renamed = rewriteMcpIdentity(
    files,
    "mcps/design.yaml",
    "mcps/figma.yaml",
  );

  expect(renamed[0].content).toContain("figma");
  expect(renamed[1].path).toBe("mcps/figma.yaml");
  expect(renamed[2].content).toContain("figma");
  expect(renamed[3].content).toContain("figma");
  expect(
    validateCatalogFiles(renamed, new Set(renamed.map((f) => f.path))),
  ).toEqual([]);
  const divergent = renamed.map((f) =>
    f.path.endsWith("/figma.yaml")
      ? {
          ...f,
          content: f.content.replace(
            "https://example.com",
            "https://figma.com",
          ),
        }
      : f,
  );

  expect(
    validateCatalogFiles(divergent, new Set(["mcps/figma.yaml"])),
  ).toHaveLength(1);
  const removed = rewriteMcpIdentity(renamed, "mcps/figma.yaml", null);

  expect(removed.map((f) => f.content).join("")).not.toContain("figma");
  expect(removed.map((f) => f.path)).not.toContain("mcps/figma.yaml");
});

it("IT-CAT-01 distinguishes empty, partial and limited sources before accepting a selector", async () => {
  const { CatalogError } = await import("../catalog-client");
  const partial: CatalogClient = (url) =>
    url.pathname.includes("/anthropics/")
      ? Promise.reject(new CatalogError(429, "Rate limit"))
      : read(url);
  const reply = await searchCatalog({ kind: "skill", q: "missing" }, partial);

  expect(reply.results).toEqual([]);
  expect(reply.sources).toContainEqual({
    sourceId: "anthropic-skills",
    state: "rate_limited",
  });
  expect(reply.sources).toContainEqual({
    sourceId: "vercel-agent-skills",
    state: "available",
  });
  await expect(
    searchCatalog({ kind: "skill", q: "missing" }, async () => {
      throw new CatalogError(503, "Unavailable");
    }),
  ).rejects.toMatchObject({ status: 503 });
  await expect(
    searchCatalog({ kind: "skill", q: "missing" }, async () => {
      throw new CatalogError(429, "Rate limit");
    }),
  ).rejects.toMatchObject({ status: 429 });
});

it.each(["symlink", "oversize", "integrity", "collision"] as const)(
  "IT-CAT-01 refuses %s while resolving upstream bytes",
  async (fault) => {
    let blobReads = 0;
    const controlled: CatalogClient = async (url) => {
      if (url.pathname.includes("/git/trees/")) {
        const members =
          fault === "collision"
            ? [...tree, { ...tree[1], path: "skills/design/Companion.md" }]
            : tree;

        return {
          truncated: false,
          tree: members.map((e) =>
            e.path.endsWith("companion.md")
              ? {
                  ...e,
                  ...(fault === "symlink"
                    ? { mode: "120000" }
                    : fault === "oversize"
                      ? { size: 3000000 }
                      : {}),
                }
              : e,
          ),
        };
      }
      if (url.pathname.includes("/git/blobs/")) {
        blobReads++;
        if (fault === "integrity")
          return { encoding: "base64", content: "c3dhcHBlZA==" };
      }

      return read(url);
    };

    await expect(
      resolveCatalogSource(
        {
          kind: "skill",
          sourceId: "anthropic-skills",
          selector: "skills/design",
        },
        controlled,
      ),
    ).rejects.toMatchObject({ status: 422 });
    if (fault === "collision") expect(blobReads).toBe(0);
  },
);

it("IT-CAT-01 reviews immutable npm metadata and rejects lifecycle hooks, missing licenses and peer dependencies", async () => {
  const name = "io.github.example/design";
  const selector = name + "@1.0.0";
  const server = {
    name,
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "design",
        version: "1.0.0",
        transport: { type: "stdio" },
      },
    ],
  };
  const metadata = {
    name: "design",
    version: "1.0.0",
    mcpName: name,
    bin: { design: "index.js" },
    license: "MIT",
    dist: { integrity: "sha512-" + Buffer.alloc(64).toString("base64") },
  };
  const readMetadata =
    (value: object): CatalogClient =>
    async (url) =>
      url.hostname === "registry.npmjs.org" ? value : { server };
  const result = await resolveCatalogSource(
    { kind: "mcp", sourceId: "mcp-registry", selector },
    readMetadata(metadata),
  );

  expect(result.mcp).toMatchObject({
    id: "design",
    transport: "stdio",
    command: "design",
    distribution: {
      registryName: name,
      integrity: metadata.dist.integrity,
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  draft = path.join(
    await mkdtemp(path.join(tmpdir(), "maister-catalog-")),
    "worktree",
  );
  await mkdir(draft);
  await writeFile(
    path.join(draft, "maister-package.yaml"),
    "schemaVersion: 1\nname: demo\nflows: []\n",
  );
  await expect(
    previewCatalogImport(
      { workingDir: draft, packageId: "draft", actorId: "editor" },
      result,
      "mcps/design.yaml",
    ),
  ).resolves.toMatchObject({
    artifactDigest: result.mcp?.distribution?.artifactDigest,
    runnerCompatibility: {
      transport: "stdio",
      compatibleAdapters: ["claude", "codex", "gemini", "opencode", "mimo"],
    },
  });
  for (const unsupported of [
    { scripts: { postinstall: "node install.js" } },
    { peerDependencies: { external: "*" } },
    { license: "" },
  ]) {
    await expect(
      resolveCatalogSource(
        { kind: "mcp", sourceId: "mcp-registry", selector },
        readMetadata({ ...metadata, ...unsupported }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }
});

it("names bounded source-declared configuration on refused MCP imports without exposing values", async () => {
  const name = "org.example/needs-config",
    version = "1.0.0";
  const rejected = async (descriptor: Record<string, unknown>) => {
    const error = await resolveCatalogSource(
      { sourceId: "mcp-registry", kind: "mcp", selector: name + "@" + version },
      async () => ({ server: { name, version, ...descriptor } }),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({ status: 422 });

    return error;
  };
  const remote = await rejected({
    remotes: [
      {
        type: "streamable-http",
        url: "https://example.com/{tenant}/secret-link-token?x=hidden",
        headers: [
          { name: "Authorization", value: "top-secret" },
          { name: "authorization", description: "secret description" },
          { name: "invalid\nsecret-in-key", value: "header-value" },
        ],
        variables: {
          tenant: { default: "private-tenant" },
          region: { choices: ["hidden-region"] },
        },
      },
    ],
  });

  expect(remote).toMatchObject({
    details: {
      reason: "remote_requirements_unsupported",
      headers: { names: ["Authorization"], more: false },
      urlVariables: { names: ["tenant", "region"], more: false },
    },
  });
  expect(JSON.stringify(remote)).not.toMatch(
    /secret|hidden|example\.com|private-tenant|header-value/,
  );
  const npm = await rejected({
    packages: [
      {
        registryType: "npm",
        identifier: "example-mcp",
        version,
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "API_KEY", default: "secret-key" },
          ...Array.from({ length: 30 }, (_, i) => ({
            name: "OPTION_" + i,
            value: "private",
          })),
        ],
      },
    ],
  });

  expect(npm).toMatchObject({
    details: {
      reason: "distribution_requirements_unsupported",
      environmentVariables: {
        names: [
          "API_KEY",
          ...Array.from({ length: 7 }, (_, i) => `OPTION_${i}`),
        ],
        more: true,
      },
    },
  });
  expect(JSON.stringify(npm)).not.toMatch(/secret-key|private|OPTION_29/);
});

it("returns reusable Registry cursors within the public query budget even for multibyte source tokens", async () => {
  const read = (token: string) => async () => ({
    servers: [],
    metadata: { nextCursor: token },
  });
  const valid = "Я".repeat(700);
  const page = await fetchRegistryPage("test", undefined, read(valid));

  expect(
    Buffer.from("a".repeat(20) + "|" + page.cursor).toString("base64url")
      .length,
  ).toBeLessThanOrEqual(2048);
  await expect(
    fetchRegistryPage("test", undefined, read("界".repeat(700))),
  ).rejects.toThrow();
});
