import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, expect, it, vi } from "vitest";
import { create, Header } from "tar";

import { prepareMcpDistribution } from "../mcp-distribution";

const roots: string[] = [];
const manifest = {
  name: "test-mcp",
  version: "1.0.0",
  mcpName: "io.example/test",
  license: "MIT",
  bin: { "test-mcp": "server.mjs" },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function descriptor(bytes: Uint8Array) {
  const integrity =
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        manifest.mcpName,
        manifest.name,
        manifest.version,
        integrity,
        "test-mcp",
      ]),
    )
    .digest("hex");

  return {
    registryName: manifest.mcpName,
    packageName: manifest.name,
    version: manifest.version,
    integrity,
    executable: "test-mcp",
    artifactDigest: digest,
    runtime: "node" as const,
  };
}

async function fixture(
  fields: Record<string, unknown> = {},
  files: Record<string, Uint8Array> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "maister-install-"));

  roots.push(root);
  await mkdir(join(root, "package"));
  await writeFile(
    join(root, "package", "package.json"),
    JSON.stringify({ ...manifest, ...fields }),
  );
  await writeFile(
    join(root, "package", "server.mjs"),
    'export const version = "1.0.0"',
  );
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(root, "package", name), bytes);
  }
  const archive = join(root, "fixture.tgz");

  await create({ gzip: true, cwd: root, file: archive }, ["package"]);
  const bytes = await readFile(archive);
  const distribution = descriptor(bytes);
  const fetchArchive = vi.fn(async () => Uint8Array.from(bytes));
  const options = {
    cacheRoot: join(root, "cache"),
    allowedDigests: [distribution.artifactDigest],
    fetchArchive,
    assertCurrent: () => {},
  };

  return { options, distribution, archive, bytes, fetchArchive };
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
    code: "PRECONDITION",
    message: expect.stringContaining(distribution.artifactDigest),
    details: {
      reason: "mcp_distribution_untrusted",
      artifactDigest: distribution.artifactDigest,
    },
  });
  await writeFile(first.entry, "changed");
  await expect(
    prepareMcpDistribution(distribution, offline),
  ).rejects.toMatchObject({
    details: { reason: "mcp_distribution_integrity" },
  });
});

it("reclaims an interrupted stage during another cold install while preserving live and unknown directories", async () => {
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

  expect(await readdir(runtime)).toEqual([
    expect.stringContaining(`${distribution.artifactDigest}.stage-`),
  ]);
  const other = await fixture({ license: "ISC" });
  const live = await mkdtemp(
    join(
      runtime,
      `${other.distribution.artifactDigest}.stage-${process.ppid}-${randomUUID()}-`,
    ),
  );

  await mkdir(join(runtime, "unrelated"));
  await expect(
    prepareMcpDistribution(other.distribution, {
      ...other.options,
      cacheRoot: options.cacheRoot,
    }),
  ).resolves.toMatchObject({ cacheHit: false });
  expect((await readdir(runtime)).sort()).toEqual(
    [other.distribution.artifactDigest, basename(live), "unrelated"].sort(),
  );
  const recovered = await prepareMcpDistribution(distribution, options);

  expect(recovered.cacheHit).toBe(false);
  expect(recovered.entry).toBe(
    join(runtime, distribution.artifactDigest, "package", "server.mjs"),
  );
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

it.each([
  { path: "package/example/../fixture.txt", type: "File" },
  {
    path: "package/fixture-link",
    type: "SymbolicLink",
    linkpath: "server.mjs",
  },
  {
    path: "package/fixture-link",
    type: "Link",
    linkpath: "package/server.mjs",
  },
] as const)(
  "refuses the tar member $type $path without publication",
  async (member) => {
    const { options, bytes, fetchArchive } = await fixture();
    const header = Buffer.alloc(512);

    new Header({ ...member, size: 0 }).encode(header);
    const archive = gzipSync(Buffer.concat([header, gunzipSync(bytes)]));
    const reviewed = descriptor(archive);

    fetchArchive.mockResolvedValue(archive);
    await expect(
      prepareMcpDistribution(reviewed, {
        ...options,
        allowedDigests: [reviewed.artifactDigest],
      }),
    ).rejects.toMatchObject({
      details: { reason: "mcp_distribution_unsupported" },
    });
    await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each(["preinstall", "install", "postinstall"])(
  "refuses a manifest with a %s lifecycle hook before publication",
  async (hook) => {
    const { options, distribution } = await fixture({
      scripts: { [hook]: "inert-test-placeholder" },
    });

    await expect(
      prepareMcpDistribution(distribution, options),
    ).rejects.toMatchObject({
      details: { reason: "mcp_distribution_unsupported" },
    });
    await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("compares the archive's publisher against the reviewed descriptor after verifying its bytes", async () => {
  const { options, distribution } = await fixture({
    mcpName: "io.example/different",
  });

  await expect(
    prepareMcpDistribution(distribution, options),
  ).rejects.toMatchObject({
    message: expect.stringContaining("publisher"),
    details: { reason: "mcp_distribution_integrity" },
  });
  await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("checks the descriptor digest before registry access, even if the supplied digest is allowed", async () => {
  const { options, distribution, fetchArchive } = await fixture();
  const artifactDigest = "a".repeat(64);

  await expect(
    prepareMcpDistribution(
      { ...distribution, artifactDigest },
      {
        ...options,
        allowedDigests: [artifactDigest],
      },
    ),
  ).rejects.toMatchObject({
    details: { reason: "mcp_distribution_integrity" },
  });
  expect(fetchArchive).not.toHaveBeenCalled();
  await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a different valid npm archive for the pinned SHA-512 and can retry with the exact bytes", async () => {
  const { options, distribution, fetchArchive } = await fixture();
  const differentArchive = await fixture({ license: "ISC" });

  fetchArchive.mockResolvedValueOnce(differentArchive.bytes);
  await expect(
    prepareMcpDistribution(distribution, options),
  ).rejects.toMatchObject({
    details: { reason: "mcp_distribution_integrity" },
  });
  await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    prepareMcpDistribution(distribution, options),
  ).resolves.toMatchObject({ cacheHit: false });
});

it("enforces the decompressed byte budget even for a highly compressible valid archive", async () => {
  const { options, distribution, bytes } = await fixture(
    {},
    {
      "padding.bin": Buffer.alloc(64 * 1024 * 1024),
    },
  );

  expect(bytes.length).toBeLessThan(1024 * 1024);
  await expect(
    prepareMcpDistribution(distribution, options),
  ).rejects.toMatchObject({
    message: expect.stringContaining("decompression limit"),
    details: { reason: "mcp_distribution_unsupported" },
  });
  await expect(lstat(options.cacheRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
