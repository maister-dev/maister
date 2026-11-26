import type { PublicHostMcpReceipt } from "./assigned-mcp-public-probe";
import type { McpDistribution } from "../../runtime/mcp-distribution";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { probeFixedPublicMcp } from "./assigned-mcp-public-probe";

const execute = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  return (
    await execute("docker", args, { timeout: 120_000, maxBuffer: 5_000_000 })
  ).stdout.trim();
}

/** Present the production client's loopback endpoint through the lab's private mTLS edge. */
async function startSupervisorTunnel(
  port: number,
  credentials: Readonly<{ cert: Buffer; key: Buffer }>,
): Promise<Readonly<{ url: string; close: () => Promise<void> }>> {
  const connections = new Set<Socket>();
  const server = createServer((incoming) => {
    const upstream = connectTls({
      host: "127.0.0.1",
      port,
      ...credentials,
      ca: credentials.cert,
    });

    connections.add(incoming);
    incoming.on("error", () => upstream.destroy());
    upstream.on("error", () => incoming.destroy());
    incoming.on("close", () => {
      connections.delete(incoming);
      upstream.destroy();
    });
    upstream.on("close", () => incoming.destroy());
    incoming.pipe(upstream).pipe(incoming);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("The qualification tunnel has no loopback port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      for (const connection of connections) connection.destroy();

      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Supervisor/ACP traffic stays private. The opt-in fixed public probe runs before the supervisor starts. */
export async function withAssignedMcpHosts(
  qualify: (lab: {
    descriptor: McpDistribution;
    setOnline: (online: boolean) => Promise<void>;
    counts: () => Promise<{
      downloads: number;
      httpCalls: number;
      facadeCalls: number;
    }>;
    start: (
      key: string,
    ) => Promise<{ url: string; publicReceipt?: PublicHostMcpReceipt }>;
    stop: (key: string) => Promise<void>;
    receipt: (
      key: string,
    ) => Promise<{ host: string; inventory: string[]; stdioExited: boolean }>;
  }) => Promise<void>,
): Promise<void> {
  const image = process.env.MAISTER_MCP_QUALIFICATION_IMAGE;
  const filterImage = process.env.MAISTER_MCP_QUALIFICATION_PUBLIC_FILTER_IMAGE;

  if (!image)
    throw new Error(
      "Set MAISTER_MCP_QUALIFICATION_IMAGE to the production image built from the checkout under qualification",
    );
  await docker("image", "inspect", image);
  const id = "mcpq-" + randomUUID().slice(0, 10);
  const dir = await mkdtemp(join(tmpdir(), id));
  const certs = join(dir, "certs");
  const clean: Array<() => Promise<unknown>> = [];

  try {
    await mkdir(certs);
    await execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(certs, "key"),
      "-out",
      join(certs, "ca.pem"),
      "-subj",
      "/CN=qualification",
      "-addext",
      "subjectAltName=DNS:qual-web,DNS:registry.npmjs.org,IP:127.0.0.1",
    ]);
    await docker("network", "create", "--internal", id);
    clean.push(() => docker("network", "rm", id));
    const edge = id + "-loopback";

    await docker("network", "create", edge);
    clean.push(() => docker("network", "rm", edge));
    const publicEdge = id + "-public";

    if (filterImage) {
      await docker("image", "inspect", filterImage);
      await docker("network", "create", publicEdge);
      clean.push(() => docker("network", "rm", publicEdge));
    }
    const service = id + "-a";

    await docker(
      "run",
      "-d",
      "--pull=never",
      "--name",
      service,
      "--hostname",
      "qual-web",
      "--network",
      edge,
      "-p",
      "127.0.0.1::9071",
      "-p",
      "127.0.0.1::9072",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--user",
      "0:0",
      "-v",
      certs + ":/certs:ro",
      "--workdir",
      "/app/supervisor",
      "--entrypoint",
      "node",
      image,
      "test/assigned-mcp/service.mjs",
    );
    clean.push(() => docker("rm", "-f", service));
    await docker(
      "network",
      "connect",
      "--alias",
      "qual-web",
      "--alias",
      "registry.npmjs.org",
      id,
      service,
    );
    const api = async (path: string): Promise<string> =>
      docker(
        "exec",
        "-e",
        "NODE_EXTRA_CA_CERTS=/certs/ca.pem",
        service,
        "node",
        "-e",
        "fetch('https://qual-web/'+process.argv[1]).then(async r=>{if(!r.ok)throw Error(String(r.status));console.log(await r.text())})",
        path,
      );
    let descriptor: McpDistribution | undefined;

    for (let i = 0; i < 30; i++) {
      try {
        descriptor = JSON.parse(await api("descriptor")) as McpDistribution;
        break;
      } catch (error) {
        if (i === 29) throw error;
        await delay(150);
      }
    }
    if (!descriptor) throw new Error("Fixture metadata unavailable");
    const artifactDigest = descriptor.artifactDigest;
    const name = (key: string) => id + "-" + key;

    const [cert, keyPem] = await Promise.all([
      readFile(join(certs, "ca.pem")),
      readFile(join(certs, "key")),
    ]);
    const tunnels = new Map<string, () => Promise<void>>();

    await qualify({
      descriptor,
      setOnline: async (online) => {
        await api(online ? "online" : "offline");
      },
      counts: async () => JSON.parse(await api("counters")),
      start: async (key) => {
        const containerId = await docker(
          "run",
          "-d",
          "--pull=never",
          "--name",
          name(key),
          "--hostname",
          key,
          "--network",
          id,
          "--network-alias",
          key,
          "--read-only",
          "--tmpfs",
          "/tmp",
          "--tmpfs",
          "/state:uid=1001,gid=1001,mode=0700",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "-v",
          join(certs, "ca.pem") + ":/ca.pem:ro",
          "-e",
          "MAISTER_API_BASE_URL=https://qual-web",
          "-e",
          'MAISTER_WORKSPACE_DIRECTORIES={"qualification":"/state/work"}',
          "-e",
          "NODE_EXTRA_CA_CERTS=/ca.pem",
          "-e",
          "MAISTER_EXECUTION_HOST_KEY=" + key,
          "-e",
          "MAISTER_MCP_SECRET_HTTP=synthetic_http",
          "-e",
          "MAISTER_MCP_ALLOWED_DIGESTS=" + artifactDigest,
          "-e",
          "MAISTER_RUNTIME_ROOT=/state",
          "-e",
          "MAISTER_WORKSPACE_ROOTS=/state",
          "-e",
          "MAISTER_EXECUTION_HOST_STATE_DIR=/state/host",
          "-e",
          "MAISTER_ADAPTER_BINARY_CLAUDE=/app/supervisor/test/assigned-mcp/adapter.mjs",
          "--workdir",
          "/app/supervisor",
          "--entrypoint",
          filterImage ? "/bin/sh" : "node",
          image,
          ...(filterImage
            ? [
                "-ec",
                "while [ ! -e /tmp/start-supervisor ]; do sleep 0.1; done; exec node --import tsx src/main.ts",
              ]
            : ["--import", "tsx", "src/main.ts"]),
        );

        clean.push(() => docker("rm", "-f", name(key)));
        const publicReceipt = filterImage
          ? await probeFixedPublicMcp({
              container: containerId,
              privateNetwork: id,
              egressNetwork: publicEdge,
              filterImage,
            })
          : undefined;

        if (publicReceipt)
          await docker("exec", containerId, "touch", "/tmp/start-supervisor");
        const port = (
          await docker(
            "port",
            service,
            key === "supervisor-b" ? "9071/tcp" : "9072/tcp",
          )
        )
          .split(":")
          .at(-1);
        const edgePort = Number(port);

        if (!Number.isInteger(edgePort) || edgePort < 1)
          throw new Error("The qualification edge did not publish a TCP port");

        for (let i = 0; i < 100; i++) {
          try {
            if (
              (await docker(
                "exec",
                service,
                "node",
                "-e",
                "fetch('http://'+process.argv[1]+':7777/health').then(r=>console.log(r.ok)).catch(()=>process.exit(1))",
                key,
              )) === "true"
            )
              break;
          } catch {
            /* Startup precedes the first health response. */
          }
          if (i === 99)
            throw new Error(
              "Supervisor failed to start: " +
                (await docker("logs", name(key))).slice(-1200),
            );
          await delay(120);
        }
        await docker("exec", name(key), "mkdir", "-p", "/state/work");

        const tunnel = await startSupervisorTunnel(edgePort, {
          cert,
          key: keyPem,
        });

        tunnels.set(key, tunnel.close);
        clean.push(async () => {
          if (tunnels.delete(key)) await tunnel.close();
        });

        return { url: tunnel.url, publicReceipt };
      },
      stop: async (key) => {
        await docker("stop", "-t", "4", name(key));
        const close = tunnels.get(key);

        if (close) {
          await close();
          tunnels.delete(key);
        }
      },
      receipt: async (key) =>
        JSON.parse(
          await docker(
            "exec",
            name(key),
            "cat",
            "/state/work/tool-receipt.json",
          ),
        ),
    });
  } finally {
    try {
      for (const release of clean.reverse()) await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
