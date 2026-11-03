import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let input = "";

for await (const chunk of process.stdin) input += chunk;
const { companyId, recordId, query, content, key } = JSON.parse(input);
const client = new Client({ name: "native-knowledge-wire-qualification", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js", "--stdio"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
  },
});

process.once("SIGTERM", () => {
  void client.close().finally(() => process.exit(143));
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const owner = { kind: "company", companyId };
  const capture = await client.callTool({ name: "knowledge_capture_source", arguments: { owner, title: "Real MCP capture", content, idempotencyKey: key } });
  const record = await client.callTool({ name: "knowledge_get", arguments: { recordId, revision: 1 } });
  const search = await client.callTool({ name: "knowledge_search", arguments: { owner, q: query, limit: 1 } });
  const evidence = await client.callTool({ name: "knowledge_evidence", arguments: { recordId, revision: 1 } });
  const conflicts = await client.callTool({ name: "knowledge_conflicts", arguments: { recordId, revision: 1 } });
  const malformed = [];

  for (const argumentsValue of [
    { owner: { ...owner, projectId: "forged" }, title: "Forged", content, idempotencyKey: key },
    { owner, title: "Forged", content, idempotencyKey: key, attribution: { kind: "user", id: "forged" } },
    { owner, title: "NUL", content: "bad\0text", idempotencyKey: key },
    { owner, title: "Surrogate", content: "bad\ud800text", idempotencyKey: key },
  ]) malformed.push(await client.callTool({ name: "knowledge_capture_source", arguments: argumentsValue }));
  for (const revision of [0, 2147483648])
    malformed.push(await client.callTool({ name: "knowledge_get", arguments: { recordId, revision } }));
  process.stdout.write(JSON.stringify({ tools: tools.filter(tool => tool.name.startsWith("knowledge_")), capture, record, search, evidence, conflicts, malformed }));
} finally {
  await client.close();
}
