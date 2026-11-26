import { hostname } from "node:os";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) continue;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : request.method === "tools/list"
        ? { tools: [{ name: "identify", inputSchema: { type: "object" } }] }
        : {
            content: [
              {
                type: "text",
                text: JSON.stringify({ host: hostname(), pid: process.pid }),
              },
            ],
          };
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
}
