import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import { promisify } from "node:util";

import pino from "pino";

import { isBlockedAddress } from "@/lib/webhooks/destination";

const execute = promisify(execFile);
const log = pino({ name: "assigned-mcp-public-qualification" });
const domain = "learn.microsoft.com";
const endpoint = "https://learn.microsoft.com/api/mcp";
const article = "https://learn.microsoft.com/en-us/dotnet/core/introduction";
const request = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "microsoft_docs_fetch", arguments: { url: article } },
});
const probeUser = "65534:65534";
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type PublicHostMcpReceipt = {
  containerId: string;
  internalAddress: string;
  publicPeer: string;
  endpoint: string;
  article: string;
  tool: "microsoft_docs_fetch";
  requestSha256: string;
  httpStatus: number;
  responseBytes: number;
  responseSha256: string;
};

async function docker(...args: string[]): Promise<string> {
  return (
    await execute("docker", args, { timeout: 30_000, maxBuffer: 512_000 })
  ).stdout;
}

// The helper shares only the lab container's network namespace. No other
// process UID or IPv6 destination can transmit while the public link exists.
const installRules = [
  "set -eu",
  "iptables -w -N HST_PUBLIC_ONLY",
  'iptables -w -A HST_PUBLIC_ONLY -m owner --uid-owner 65534 -p tcp -d "$1" --dport 443 -j ACCEPT',
  "iptables -w -A HST_PUBLIC_ONLY -j DROP",
  "iptables -w -I OUTPUT 1 -j HST_PUBLIC_ONLY",
  "ip6tables -w -I OUTPUT 1 -j DROP",
].join("\n");
const removeRules = [
  "set -eu",
  "ip6tables -w -D OUTPUT -j DROP",
  "iptables -w -D OUTPUT -j HST_PUBLIC_ONLY",
  "iptables -w -F HST_PUBLIC_ONLY",
  "iptables -w -X HST_PUBLIC_ONLY",
].join("\n");

function parseResponse(body: string): void {
  const json = body.startsWith("{")
    ? body
    : body
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "))
        ?.slice(6);

  if (!json) throw new Error("Microsoft Learn returned no JSON-RPC response");
  const response = JSON.parse(json) as {
    id?: number;
    jsonrpc?: string;
    result?: {
      isError?: boolean;
      content?: { type?: string; text?: string }[];
    };
  };

  if (
    response.jsonrpc !== "2.0" ||
    response.id !== 1 ||
    response.result?.isError ||
    !response.result?.content?.some(
      (item) => item.type === "text" && item.text?.includes(".NET"),
    )
  )
    throw new Error(
      "Microsoft Learn did not return the requested .NET article",
    );
}

/** Call the fixed public article before the supervisor starts in this exact container. */
export async function probeFixedPublicMcp(host: {
  container: string;
  privateNetwork: string;
  egressNetwork: string;
  filterImage: string;
}): Promise<PublicHostMcpReceipt> {
  const { address } = await lookup(domain, { family: 4 });

  if (!isIPv4(address) || isBlockedAddress(address))
    throw new Error("Microsoft Learn requires a public IPv4 address");
  const inspect = async () =>
    JSON.parse((await docker("inspect", host.container)).trim())[0] as {
      Id: string;
      NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
    };
  const before = await inspect();

  if (
    Object.keys(before.NetworkSettings.Networks).length !== 1 ||
    !before.NetworkSettings.Networks[host.privateNetwork]?.IPAddress
  )
    throw new Error(
      "Public preflight requires the solitary private lab network",
    );
  const rules = (script: string) =>
    docker(
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "container:" + before.Id,
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "/bin/sh",
      host.filterImage,
      "-ec",
      script,
      "qualification",
      address,
    );

  await rules(installRules);
  await docker(
    "network",
    "connect",
    "--gw-priority",
    "100",
    host.egressNetwork,
    before.Id,
  );
  let output: string;

  try {
    log.info(
      { containerId: before.Id, publicPeer: address, endpoint, article },
      "Sending one fixed public MCP request",
    );
    output = await docker(
      "exec",
      "--user",
      probeUser,
      "--workdir",
      "/tmp",
      before.Id,
      "/usr/bin/env",
      "-i",
      "/usr/bin/curl",
      "-q",
      "--silent",
      "--show-error",
      "--fail",
      "--proto",
      "=https",
      "--ipv4",
      "--max-redirs",
      "0",
      "--retry",
      "0",
      "--noproxy",
      "*",
      "--connect-timeout",
      "8",
      "--max-time",
      "20",
      "--max-filesize",
      "262144",
      "--resolve",
      domain + ":443:" + address,
      "--header",
      "Content-Type: application/json",
      "--header",
      "Accept: application/json, text/event-stream",
      "--data-binary",
      request,
      "--write-out",
      "\n%{http_code} %{remote_ip}",
      endpoint,
    );
  } finally {
    // A failed probe or disconnect never releases the supervisor bootstrap.
    await docker("network", "disconnect", host.egressNetwork, before.Id);
  }

  const after = await inspect();

  if (
    after.Id !== before.Id ||
    JSON.stringify(after.NetworkSettings.Networks) !==
      JSON.stringify(before.NetworkSettings.Networks)
  )
    throw new Error(
      "Public preflight did not restore private-only connectivity",
    );
  await rules(removeRules);
  const divider = output.lastIndexOf("\n");
  const body = output.slice(0, divider);

  if (divider < 0 || output.slice(divider + 1) !== "200 " + address)
    throw new Error(
      "Public preflight did not prove its peer address and status",
    );
  parseResponse(body);

  const receipt: PublicHostMcpReceipt = {
    containerId: before.Id,
    internalAddress:
      before.NetworkSettings.Networks[host.privateNetwork].IPAddress,
    publicPeer: address,
    endpoint,
    article,
    tool: "microsoft_docs_fetch",
    requestSha256: digest(request),
    httpStatus: 200,
    responseBytes: Buffer.byteLength(body),
    responseSha256: digest(body),
  };

  log.info(receipt, "Public MCP receipt");

  return receipt;
}
