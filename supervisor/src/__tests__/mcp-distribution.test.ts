import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { create } from "tar";

import { prepareMcpDistribution } from "../mcp-distribution";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(fields: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "maister-install-"));

  roots.push(root);
  await mkdir(join(root, "package"));
  const pkg = {
    name: "test-mcp",
    version: "1.0.0",
    mcpName: "io.example/test",
    license: "MIT",
    bin: { "test-mcp": "server.mjs" },
    ...fields,
  };

  await writeFile(join(root, "package", "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(root, "package", "server.mjs"),
    'export const version = "1.0.0"',
  );
  const archive = join(root, "fixture.tgz");

  await create({ gzip: true, cwd: root, file: archive }, ["package"]);
  const bytes = await readFile(archive);
  const integrity =
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        pkg.mcpName,
        pkg.name,
        pkg.version,
        integrity,
        "test-mcp",
      ]),
    )
    .digest("hex");
  const distribution = {
    registryName: pkg.mcpName,
    packageName: pkg.name,
    version: pkg.version,
    integrity,
    executable: "test-mcp",
    artifactDigest: digest,
    runtime: "node" as const,
  };
  const fetchArchive = vi.fn(async () => Uint8Array.from(bytes));
  const options = {
    cacheRoot: join(root, "cache"),
    allowedDigests: [digest],
    fetchArchive,
    assertCurrent: () => {},
  };

  return { options, distribution, archive, fetchArchive };
}

it("IT-HST-02 shares verified npm bytes across installs, reuses offline and refuses a changed file or revoked digest", async () => {
  const { options, distribution, fetchArchive } = await fixture();
  const [first, second] = await Promise.all([
    prepareMcpDistribution(distribution, options),
    prepareMcpDistribution(distribution, options),
  ]);

  expect(first.entry).toBe(second.entry);
  expect(fetchArchive).toHaveBeenCalledTimes(1);
  const offline = {
    ...options,
    fetchArchive: async () => {
      throw new Error("offline");
    },
  };

  expect(await prepareMcpDistribution(distribution, offline)).toMatchObject({
    entry: first.entry,
    cacheHit: true,
  });
  await expect(
    prepareMcpDistribution(distribution, { ...offline, allowedDigests: [] }),
  ).rejects.toMatchObject({
    details: { reason: "mcp_distribution_untrusted" },
  });
  await writeFile(first.entry, "changed");
  await expect(
    prepareMcpDistribution(distribution, offline),
  ).rejects.toMatchObject({
    details: { reason: "mcp_distribution_integrity" },
  });
});

it("recovers from process death while staged without exposing or retaining partial bytes", async () => {
  const { options, distribution, archive } = await fixture();
  const module = new URL("../mcp-distribution.ts", import.meta.url).href;
  const program = `
    import {prepareMcpDistribution} from ${JSON.stringify(module)};
    import {readFile} from "node:fs/promises";
    const distribution=JSON.parse(process.argv[1]);
    let fences=0;
    await prepareMcpDistribution(distribution,{
      cacheRoot:process.argv[2],allowedDigests:[distribution.artifactDigest],
      fetchArchive:()=>readFile(process.argv[3]),
      assertCurrent:()=>{if(++fences===2)process.kill(process.pid,"SIGKILL");}
    });`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module",
      "-e",
      program,
      JSON.stringify(distribution),
      options.cacheRoot,
      archive,
    ],
    { stdio: "inherit" },
  );

  expect(await once(child, "exit")).toEqual([null, "SIGKILL"]);
  const runtime = join(
    options.cacheRoot,
    process.platform + "-" + process.arch + "-" + process.version,
  );

  expect(await readdir(runtime)).not.toContain(distribution.artifactDigest);
  const recovered = await prepareMcpDistribution(distribution, options);

  expect(recovered.cacheHit).toBe(false);
  expect(await readdir(runtime)).toEqual([distribution.artifactDigest]);
});

it.each([
  [{ engines: { node: ">=900.0.0" } }, "mcp_distribution_runtime"],
  [{ os: ["!" + process.platform] }, "mcp_distribution_runtime"],
  [{ peerDependencies: { external: "*" } }, "mcp_distribution_unsupported"],
] as const)(
  "refuses an unsupported package before publication: %j",
  async (fields, reason) => {
    const { options, distribution } = await fixture(fields);

    await expect(
      prepareMcpDistribution(distribution, options),
    ).rejects.toMatchObject({ details: { reason } });
  },
);
