import { readFile } from "node:fs/promises";
import { request } from "node:http";

import { IsolationPolicyError } from "./linux-isolation";

type Endpoint = Readonly<{ host: string; port: number }>;

function listeningEndpoints(text: string, ipv6: boolean): readonly Endpoint[] {
  return text
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line): Endpoint[] => {
      const fields = line.trim().split(/\s+/u);

      if (fields.length < 4)
        throw new IsolationPolicyError("unreadable TCP listener inventory");
      if (fields[3] !== "0A") return [];
      const [address, portText] = fields[1].split(":");
      const port = Number.parseInt(portText, 16);

      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !/^[0-9A-F]+$/u.test(address)
      )
        throw new IsolationPolicyError("invalid TCP listener inventory");
      const bytes = Buffer.from(address, "hex");
      let host: string;

      if (ipv6) {
        if (bytes.length !== 16)
          throw new IsolationPolicyError("invalid IPv6 listener address");
        for (let offset = 0; offset < 16; offset += 4)
          bytes.subarray(offset, offset + 4).reverse();
        host = bytes.every((byte) => byte === 0)
          ? "::1"
          : Array.from({ length: 8 }, (_, index) =>
              bytes.readUInt16BE(index * 2).toString(16),
            ).join(":");
      } else {
        if (bytes.length !== 4)
          throw new IsolationPolicyError("invalid IPv4 listener address");
        host = bytes.every((byte) => byte === 0)
          ? "127.0.0.1"
          : [...bytes.reverse()].join(".");
      }

      return [{ host, port }];
    });
}

/** A real unauthenticated Engine response is authority even without a mounted socket. */
function isDockerEngine(endpoint: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(value);
    };
    const client = request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        path: "/version",
        method: "GET",
        agent: false,
      },
      (response) => {
        if (response.statusCode !== 200) {
          finish(false);

          return;
        }
        let body = "";

        response.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(body) + chunk.length > 16_384) finish(false);
          else body += chunk.toString("utf8");
        });
        response.once("error", () => finish(false));
        response.once("end", () => {
          let value: unknown;

          try {
            value = JSON.parse(body);
          } catch {
            finish(false);

            return;
          }
          finish(
            typeof value === "object" &&
              value !== null &&
              "ApiVersion" in value &&
              typeof value.ApiVersion === "string" &&
              "MinAPIVersion" in value &&
              typeof value.MinAPIVersion === "string" &&
              "Os" in value &&
              typeof value.Os === "string",
          );
        });
      },
    );
    const timer = setTimeout(() => finish(false), 1_000);

    client.once("error", () => finish(false));
    client.end();
  });
}

/** Checks every host TCP listener and the explicitly configured daemon endpoint. */
export async function assertNoLinuxDockerTcpAuthority(): Promise<void> {
  if (process.platform !== "linux")
    throw new IsolationPolicyError(
      "Linux network authority inspection requires Linux",
    );
  const inventories = await Promise.all([
    readFile("/proc/net/tcp", "utf8"),
    readFile("/proc/net/tcp6", "utf8"),
  ]);
  const endpoints = [
    ...listeningEndpoints(inventories[0], false),
    ...listeningEndpoints(inventories[1], true),
  ];
  const configured = process.env.DOCKER_HOST;

  if (
    configured &&
    !configured.startsWith("unix://") &&
    !configured.startsWith("npipe://")
  ) {
    const url = new URL(configured);

    if (!["tcp:", "http:", "https:"].includes(url.protocol))
      throw new IsolationPolicyError(
        "unsupported Docker endpoint authority contract",
      );
    endpoints.push({
      host: url.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(url.port || (url.protocol === "https:" ? 2376 : 2375)),
    });
  }
  const unique = [
    ...new Map(
      endpoints.map((endpoint) => [
        `${endpoint.host}:${endpoint.port}`,
        endpoint,
      ]),
    ).values(),
  ];

  if (unique.length > 256)
    throw new IsolationPolicyError(
      "TCP authority inventory exceeds its inspection bound",
    );
  for (let index = 0; index < unique.length; index += 16) {
    const exposed = await Promise.all(
      unique.slice(index, index + 16).map(isDockerEngine),
    );

    if (exposed.some(Boolean))
      throw new IsolationPolicyError(
        "unauthenticated Docker TCP authority is reachable by the isolated web; require a Unix-only or authenticated daemon",
      );
  }
}
