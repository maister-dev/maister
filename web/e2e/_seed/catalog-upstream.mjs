import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const dns = require("node:dns/promises");
const undici = require("undici");
const lookup = dns.lookup;
const fetch = undici.fetch;
const github = "api.github.com";
const registry = "registry.modelcontextprotocol.io";
const npm = "registry.npmjs.org";
const hosts = new Set([github, registry, npm]);
const isolatedCacheRoot = process.env.MAISTER_E2E_CATALOG_HOME;

if (isolatedCacheRoot) {
  if (!isAbsolute(isolatedCacheRoot))
    throw new Error("The isolated catalog fixture root must be absolute");
  os.homedir = () => isolatedCacheRoot;
}
const repo = "/repos/fixture/catalog-skills";
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const packageName = "maister-e2e-design-mcp";
const registryName = "com.example/design";
const version = "1.0.0";
const executable = "design-mcp";
const integrity = "sha512-" + createHash("sha512").update("fixture archive").digest("base64");
const paths = new Map(
  ["design", "old", "intermediate", "old-preview", "unavailable"].map((name) => [
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Review ${name}.\n---\nRead companion.md\n`,
  ]),
);

paths.set("skills/design/companion.md", "Fixture journey");
const blobs = new Map();
const entries = Array.from(paths, ([path, content]) => {
  const bytes = Buffer.from(content);
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

  blobs.set(sha, { encoding: "base64", content: bytes.toString("base64"), path });

  return { path, sha, size: bytes.length, type: "blob", mode: "100644" };
});

function fixtureReply(url) {
  if (url.hostname === github) {
    if (url.pathname === `${repo}/commits/HEAD`)
      return undici.Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    if (url.pathname === `${repo}/git/trees/${tree}` && url.searchParams.get("recursive") === "1")
      return undici.Response.json({ tree: entries, truncated: false });
    if (url.pathname.startsWith(`${repo}/git/blobs/`)) {
      const blob = blobs.get(url.pathname.split("/").at(-1));

      if (blob && blob.path !== "skills/unavailable/SKILL.md") return undici.Response.json(blob);

      return undici.Response.json({ message: "Unknown fixture blob" }, { status: 404 });
    }
  }
  if (url.hostname === registry) {
    const root = "/v0.1/servers";
    const identity = { name: registryName, version };
    const authRequired = { name: "com.example/needs-config", version };

    if (url.pathname === root && url.searchParams.get("search") === "design")
      return undici.Response.json({ servers: [{ server: identity }], metadata: {} });
    if (url.pathname === root && url.searchParams.get("search") === "needs-config")
      return undici.Response.json({ servers: [{ server: authRequired }], metadata: {} });
    if (url.pathname === `${root}/${encodeURIComponent(authRequired.name)}/versions/${version}`)
      return undici.Response.json({ server: {
        ...authRequired,
        remotes: [{
          type: "streamable-http",
          url: "https://example.com/{tenant}/mcp",
          headers: [{ name: "Authorization", value: "hidden-source-token" }],
          variables: { tenant: { default: "hidden-source-tenant" } },
        }],
      } });
    if (url.pathname === `${root}/${encodeURIComponent(registryName)}/versions/${version}`)
      return undici.Response.json({ server: {
        ...identity,
        packages: [{ registryType: "npm", identifier: packageName, version, transport: { type: "stdio" } }],
      } });
  }
  if (url.hostname === npm && url.pathname === `/${packageName}/${version}`)
    return undici.Response.json({
      name: packageName, version, mcpName: registryName, bin: { [executable]: "dist/main.js" },
      license: "MIT", dist: { integrity },
    });

  return undici.Response.json({ message: "Unknown catalog fixture request" }, { status: 404 });
}

// This module is preloaded only in Playwright's owned production Web process.
// Keep the application's URL, DNS and descriptor checks on the path. The
// documentation-only address is never dialed, and an unexpected catalog
// request fails locally before it can leave the fixture.
dns.lookup = async (hostname, options) => {
  if (!hosts.has(hostname)) return lookup(hostname, options);
  const answer = { address: "192.0.2.42", family: 4 };

  return options?.all ? [answer] : answer;
};
syncBuiltinESMExports();
undici.fetch = async (input, options) => {
  if (new Headers(options?.headers).get("user-agent") !== "MAIster-Studio-Catalog")
    return fetch(input, options);

  return fixtureReply(new URL(input));
};
