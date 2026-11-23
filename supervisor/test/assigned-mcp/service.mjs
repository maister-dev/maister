import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { create } = createRequire("/app/web/package.json")("tar");
const cwd = fileURLToPath(new URL(".", import.meta.url));
await create({ cwd, gzip: true, file: "/tmp/fixture.tgz" }, ["package"]);
const bytes = await readFile("/tmp/fixture.tgz");
const integrity =
  "sha512-" + createHash("sha512").update(bytes).digest("base64");
const pkg = JSON.parse(await readFile(cwd + "package/package.json"));
const digest = createHash("sha256")
  .update(
    JSON.stringify([pkg.mcpName, pkg.name, pkg.version, integrity, "fixture"]),
  )
  .digest("hex");
const descriptor = {
  registryName: pkg.mcpName,
  packageName: pkg.name,
  version: pkg.version,
  integrity,
  executable: "fixture",
  artifactDigest: digest,
  runtime: "node",
};
let online = true;
let downloads = 0;
let facadeCalls = 0;
let httpCalls = 0;
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
createServer(
  { key: await readFile("/certs/key"), cert: await readFile("/certs/ca.pem") },
  async (req, res) => {
    if (req.url === "/descriptor") return send(res, 200, descriptor);
    if (req.url === "/counters")
      return send(res, 200, { downloads, facadeCalls, httpCalls });
    if (req.url === "/offline" || req.url === "/online") {
      online = req.url === "/online";
      return send(res, 200, { online });
    }
    if (req.url === "/maister-fixture-mcp/-/maister-fixture-mcp-1.0.0.tgz") {
      if (!online) return send(res, 503, { error: "fixture offline" });
      downloads++;
      res.end(bytes);
      return;
    }
    if (
      req.url === "/api/v1/ext/projects" &&
      req.headers.authorization === "Bearer mai_qualification_only"
    ) {
      facadeCalls++;
      return send(res, 200, { items: ["qualification-project"] });
    }
    if (
      req.url === "/mcp" &&
      req.method === "POST" &&
      req.headers.authorization === "Bearer synthetic_http"
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      if (!Object.hasOwn(msg, "id")) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result;
      switch (msg.method) {
        case "initialize":
          result = {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "private-http", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: [{ name: "identify", inputSchema: { type: "object" } }],
          };
          break;
        case "tools/call":
          httpCalls++;
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({ source: "private-http" }),
              },
            ],
          };
          break;
        default:
          return send(res, 400, { error: "unexpected method" });
      }
      return send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    }
    return send(res, 404, { error: "fixture has no matching resource" });
  },
).listen(443, "0.0.0.0");

// The control process reaches only the fixed private supervisor peers via these published loopback ports.
for (const [index, host] of ["supervisor-b", "supervisor-c"].entries()) {
  tls
    .createServer(
      {
        key: await readFile("/certs/key"),
        cert: await readFile("/certs/ca.pem"),
        ca: await readFile("/certs/ca.pem"),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (inbound) => {
        const upstream = net.connect(7777, host);
        upstream.on("error", () => inbound.destroy());
        inbound.on("error", () => upstream.destroy());
        inbound.pipe(upstream).pipe(inbound);
      },
    )
    .listen(9071 + index, "0.0.0.0");
}
